import { MetadataStorage } from '../../metadata/MetadataStorage';
import { ValidationMetadata } from '../../metadata/ValidationMetadata';
import { ValidationTypes } from '../ValidationTypes';
import { ValidatorOptions } from '../ValidatorOptions';
import { CompiledValidator, ValidationSlot } from './JitRuntime';
import * as Runtime from './JitRuntime';

/**
 * The JIT compiler turns a class's accumulated validation metadata into a
 * single optimized JavaScript function via `new Function(...)`.
 *
 * The interpreter (ValidationExecutor) walks metadata on every call, does
 * group filtering, looks up constraint instances, builds ValidationArguments
 * objects eagerly, and creates a ValidationError for every property whether
 * or not constraints fail. The JIT shifts that work to compile time:
 *
 *   - Metadata is filtered + grouped by property once.
 *   - Group/always/strictGroups predicates are precomputed per-metadata.
 *   - Constraint instances and their `defaultMessage` fns are pre-resolved.
 *   - ValidationError objects are allocated lazily (only on failure).
 *   - The per-property loop is unrolled into straight-line code.
 *
 * The compiled function is keyed by `{target ctor, metadata version}` so
 * adding metadata after first compile (via late-registered decorators)
 * transparently triggers a recompile on the next validate() call.
 */
export class JitCompiler {
  constructor(private metadataStorage: MetadataStorage) {}

  /**
   * Build a compiled validator for a single target constructor.
   * Returns a function with the {@link CompiledValidator} signature.
   */
  compile(target: Function | string): CompiledValidator {
    const targetCtor: Function | undefined = typeof target === 'string' ? undefined : target;
    const schemaName: string | undefined = typeof target === 'string' ? target : undefined;

    const allMetadata = this.collectMetadata(target);
    const knownProperties = new Set<string>();
    for (const m of allMetadata) knownProperties.add(m.propertyName);

    // Preserve the legacy ordering: subclass own properties first, then
    // properties inherited from ancestors. We rely on insertion order of the
    // metadata storage (which mirrors decoration order), and our walk visits
    // the target first, then ancestors.
    const propertyOrder: string[] = [];
    const seen = new Set<string>();
    for (const m of allMetadata) {
      // Skip WHITELIST sentinels (Allow decorator) — they don't drive
      // validation, only the known-properties set used by whitelist mode.
      if (m.type === ValidationTypes.WHITELIST) continue;
      if (!seen.has(m.propertyName)) {
        seen.add(m.propertyName);
        propertyOrder.push(m.propertyName);
      }
    }

    const byProperty: Record<string, ValidationMetadata[]> = {};
    for (const m of allMetadata) {
      if (m.type === ValidationTypes.WHITELIST) continue;
      (byProperty[m.propertyName] ||= []).push(m);
    }

    // Build slots: one per ValidationMetadata. Each slot bundles pre-resolved
    // closures (validate, defaultMessage), the effective constraint "type" key,
    // and a precomputed groupApplies predicate.
    const slots: ValidationSlot[] = [];
    // Inlined group-check JS expression per slot (faster than calling
    // slot.groupApplies for the common case where the slot has no groups
    // and no always override).
    const groupChecks: string[] = [];
    const propPlan: Record<string, PropPlan> = {};
    for (const propName of propertyOrder) {
      propPlan[propName] = { isDefined: [], conditional: [], custom: [], nested: [], promise: [] };
    }
    for (const propName of propertyOrder) {
      for (const meta of byProperty[propName]) {
        const slotIdx = slots.length;
        slots.push(this.buildSlot(meta));
        groupChecks.push(this.buildGroupCheckExpr(meta, slotIdx));
        const bucket = propPlan[propName];
        switch (meta.type) {
          case ValidationTypes.IS_DEFINED:
            bucket.isDefined.push(slotIdx);
            break;
          case ValidationTypes.CONDITIONAL_VALIDATION:
            bucket.conditional.push(slotIdx);
            break;
          case ValidationTypes.NESTED_VALIDATION:
            bucket.nested.push(slotIdx);
            break;
          case ValidationTypes.PROMISE_VALIDATION:
            bucket.promise.push(slotIdx);
            break;
          default:
            bucket.custom.push(slotIdx);
            break;
        }
      }
    }

    // Generate function source.
    const src = this.emit(propertyOrder, propPlan, knownProperties, groupChecks);

    // Compile. The generated function references stable named locals which we
    // bind via closure params: `slots`, `runtime`, `knownProps`, `schemaName`.
    // Generated body is the body of a function with parameters
    // (object, errors, ctx).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      'slots',
      'runtime',
      'knownProps',
      'schemaName',
      `return function compiledValidator(object, errors, ctx) {\n${src}\n};`
    );
    const compiled = factory(slots, Runtime, knownProperties, schemaName) as CompiledValidator;
    return compiled;
  }

  /**
   * Emit an inline JS expression that evaluates to true iff the slot at
   * `slotIdx` applies under the caller's `options`. For the common case
   * (no groups, no always override) we generate a cheap boolean expression
   * that avoids the slot.groupApplies() function call entirely. Slots with
   * groups or `always` overrides fall back to calling the closure stored
   * on the slot.
   */
  private buildGroupCheckExpr(meta: ValidationMetadata, slotIdx: number): string {
    const hasGroups = meta.groups && meta.groups.length > 0;
    const hasAlwaysOverride = typeof meta.always !== 'undefined';
    if (!hasGroups && !hasAlwaysOverride) {
      // Applies unless: caller passed groups (and meta has none -> mismatch)
      //                 OR strictGroups (no-op here because meta has no groups
      //                 anyway — strictGroups only excludes metadata WITH groups).
      // So this simplifies to: no caller groups, OR options.always is set.
      return `(!options || !options.groups || options.groups.length === 0 || options.always === true)`;
    }
    return `slots[${slotIdx}].groupApplies(options)`;
  }

  /**
   * Compose the runtime predicate that decides whether a metadata entry
   * applies given the caller's ValidatorOptions. Mirrors the rules baked
   * into {@link MetadataStorage.getTargetValidationMetadatas} but evaluated
   * once per metadata, not once per validate() call.
   */
  private buildGroupApplies(meta: ValidationMetadata): (options: ValidatorOptions | undefined) => boolean {
    const metaGroups = meta.groups && meta.groups.length ? meta.groups : undefined;
    const metaAlways = meta.always;
    const hasMetaAlways = typeof metaAlways !== 'undefined';

    return (options: ValidatorOptions | undefined): boolean => {
      const groups = options ? options.groups : undefined;
      const strictGroups = options ? !!options.strictGroups : false;
      const always = options ? !!options.always : false;

      // includeBecauseOfAlways:
      // - metadata.always overrides global
      // - if metadata has groups, never include-because-of-always
      // - otherwise fall back to global `always`
      const includeBecauseAlways = hasMetaAlways ? metaAlways : metaGroups ? false : always;
      if (includeBecauseAlways) return true;

      // excludeBecauseStrictGroups:
      // - strictGroups option AND no caller groups AND metadata has groups
      if (strictGroups && (!groups || !groups.length) && metaGroups) return false;

      if (groups && groups.length > 0) {
        if (!metaGroups) return false;
        for (const g of metaGroups) {
          if (groups.indexOf(g) !== -1) return true;
        }
        return false;
      }
      return true;
    };
  }

  /**
   * Build a {@link ValidationSlot} for a single metadata entry. Resolves the
   * constraint class to an instance once (instead of every validate() call).
   */
  private buildSlot(meta: ValidationMetadata): ValidationSlot {
    let validateFn: ValidationSlot['validateFn'];
    let defaultMessageFn: ValidationSlot['defaultMessageFn'];
    let typeName: string = meta.type;
    let async = false;

    if (meta.constraintCls) {
      const constraintMetas = this.metadataStorage.getTargetValidatorConstraints(meta.constraintCls);
      // Most decorators have exactly one constraint registered; for any with
      // multiple, run them sequentially within the slot.
      if (constraintMetas.length === 1) {
        const cm = constraintMetas[0];
        const instance = cm.instance;
        validateFn = instance.validate.bind(instance);
        if (instance.defaultMessage) defaultMessageFn = instance.defaultMessage.bind(instance);
        if (cm.name) typeName = cm.name;
        async = cm.async;
      } else if (constraintMetas.length > 1) {
        // Rare: aggregate validate() — fail if any fails. Use the first cm
        // name as the type and the first cm with defaultMessage. Async if any.
        const instances = constraintMetas.map(cm => cm.instance);
        validateFn = (value: any, args: any) => {
          const results = instances.map(inst => inst.validate(value, args));
          if (results.some(r => r && typeof r === 'object' && typeof r.then === 'function')) {
            return Promise.all(results.map(r => Promise.resolve(r))).then(rs => rs.every(Boolean));
          }
          return results.every(Boolean);
        };
        for (const cm of constraintMetas) {
          if (!defaultMessageFn && cm.instance.defaultMessage) {
            defaultMessageFn = cm.instance.defaultMessage.bind(cm.instance);
          }
          if (cm.name && typeName === meta.type) typeName = cm.name;
          if (cm.async) async = true;
        }
      }
    }

    if (meta.name && meta.type !== ValidationTypes.CUSTOM_VALIDATION) {
      // ValidationTypes.IS_DEFINED / NESTED_VALIDATION etc. use the meta.type
      // as the constraint key; named custom validations override it above.
    }

    return {
      validateFn,
      defaultMessageFn,
      type: typeName,
      message: meta.message,
      constraints: meta.constraints || [],
      each: !!meta.each,
      async,
      validateIfFn: meta.validateIf,
      context: meta.context,
      groupApplies: this.buildGroupApplies(meta),
    };
  }

  /**
   * Walk the prototype chain to collect all metadata that applies to
   * `target`, in the legacy order (own metadata first, then ancestors).
   * Dedup inherited entries that the subclass overrides (same property +
   * type pair). For schema-name targets, inheritance does not apply.
   */
  private collectMetadata(target: Function | string): ValidationMetadata[] {
    const all = (this.metadataStorage as any)['validationMetadatas'] as Map<any, ValidationMetadata[]>;

    if (typeof target === 'string') {
      // Schema mode — only entries whose target is this schema name.
      const collected: ValidationMetadata[] = [];
      for (const arr of all.values()) {
        for (const m of arr) if (m.target === target) collected.push(m);
      }
      return collected;
    }

    const original = (all.get(target) || []).filter(m => m.target === target);

    // Find inherited entries (ancestor classes).
    const inherited: ValidationMetadata[] = [];
    for (const [key, arr] of all.entries()) {
      if (typeof key === 'string') continue;
      if (target === key) continue;
      if (target.prototype instanceof key) {
        for (const m of arr) {
          if (typeof m.target === 'string') continue;
          if (m.target === target) continue;
          if (m.target instanceof Function && !(target.prototype instanceof m.target)) continue;
          inherited.push(m);
        }
      }
    }

    const uniqueInherited = inherited.filter(im => {
      return !original.find(om => om.propertyName === im.propertyName && om.type === im.type);
    });
    return original.concat(uniqueInherited);
  }

  /**
   * Emit the body of the compiled function. Generated code references:
   *   slots[N]                    — precomputed metadata slot
   *   runtime.<fn>                — runtime helpers (ensureError, runSlot, ...)
   *   knownProps                  — Set<string> of decorated property names
   *   schemaName                  — undefined for class targets, string for schemas
   *   object, errors, ctx         — function parameters
   */
  private emit(
    propertyOrder: string[],
    propPlan: Record<string, PropPlan>,
    knownProps: Set<string>,
    groupChecks: string[]
  ): string {
    // Header: forbidUnknownValues + whitelist setup. forbidUnknownValues
    // triggers a single "unknownValue" error when the class has no metadata
    // AND options.forbidUnknownValues !== false. We approximate via the
    // compile-time fact that knownProps is empty: if so, every call hits the
    // unknown-value branch (subject to runtime opt-out).
    const lines: string[] = [];
    lines.push(`  var options = ctx.validatorOptions;`);
    if (knownProps.size === 0) {
      lines.push(`  var forbidUnknownValues = !options || options.forbidUnknownValues === undefined || options.forbidUnknownValues !== false;`);
      lines.push(`  if (forbidUnknownValues) { errors.push(runtime.makeUnknownValueError(object, options)); return; }`);
      lines.push(`  return;`);
      return lines.join('\n');
    }

    // Whitelist handling — strip non-whitelisted props or push errors.
    lines.push(`  if (options && options.whitelist) { runtime.handleWhitelist(object, knownProps, options, errors); }`);

    // Per-property unrolled validation. Each property runs inside its own
    // IIFE so `return` cleanly skips remaining checks (including from inside
    // the Promise.then callback, where labeled `break` would be illegal).
    for (let pIdx = 0; pIdx < propertyOrder.length; pIdx++) {
      const propName = propertyOrder[pIdx];
      const plan = propPlan[propName];
      const propLit = JSON.stringify(propName);
      lines.push('');
      lines.push(`  /* === property ${propLit} === */`);
      lines.push(`  (function() {`);
      lines.push(`    var value = object[${propLit}];`);
      lines.push(`    var errRef = { error: undefined };`);
      lines.push(`    var getError = function() { return runtime.ensureError(errRef, errors, object, value, ${propLit}, options); };`);

      // 1) Promise unwrap — if value is a Promise and a PROMISE_VALIDATION
      //    slot exists, await the value then re-enter validation. We mirror
      //    the interpreter by pushing to ctx.awaitingPromises.
      if (plan.promise.length) {
        lines.push(`    if (value && typeof value.then === 'function') {`);
        lines.push(`      ctx.awaitingPromises.push(value.then(function(resolved) {`);
        lines.push(`        value = resolved;`);
        const inner = this.emitPropertyBody(propName, plan, groupChecks);
        for (const ln of inner) lines.push('        ' + ln);
        lines.push(`      }));`);
        lines.push(`      return;`);
        lines.push(`    }`);
      }

      // Normal path
      const body = this.emitPropertyBody(propName, plan, groupChecks);
      for (const ln of body) lines.push('    ' + ln);

      lines.push(`  })();`);
    }

    return lines.join('\n');
  }

  /**
   * Emit per-property body — IS_DEFINED, skip checks, ValidateIf gate,
   * custom validators, nested validation. The emitted code assumes it lives
   * inside a function with locals `value`, `errRef`, `getError`, plus the
   * outer-scoped `slots`, `runtime`, `object`, `errors`, `ctx`, `options`.
   * Uses `return` to short-circuit further checks for the property.
   */
  private emitPropertyBody(propName: string, plan: PropPlan, groupChecks: string[]): string[] {
    const lines: string[] = [];
    const propLit = JSON.stringify(propName);
    // Short-circuit when stopAtFirstError is set and we've already recorded
    // a constraint failure on this property. `errRef.error` is only allocated
    // after the first failure, so we only call Object.keys when an error
    // object exists, keeping the happy path branch-only.
    const stopGuard = `(options && options.stopAtFirstError && errRef.error && Object.keys(errRef.error.constraints).length > 0)`;

    // (a) IS_DEFINED — runs regardless of skip* flags.
    for (const slotIdx of plan.isDefined) {
      lines.push(`if (${groupChecks[slotIdx]}) {`);
      lines.push(`  if (!${stopGuard}) {`);
      lines.push(`    runtime.runIsDefined(slots[${slotIdx}], object, value, ${propLit}, ctx, getError);`);
      lines.push(`  }`);
      lines.push(`}`);
    }

    // (b) skip*-properties gates (apply to non-IS_DEFINED validators only).
    lines.push(`if (value === undefined && options && options.skipUndefinedProperties === true) return;`);
    lines.push(`if (value === null && options && options.skipNullProperties === true) return;`);
    lines.push(`if ((value === null || value === undefined) && options && options.skipMissingProperties === true) return;`);

    // (c) ConditionalValidation gate — all predicates must return truthy.
    if (plan.conditional.length) {
      for (const slotIdx of plan.conditional) {
        // Per the legacy executor, ConditionalValidation predicates run
        // unconditionally (no group filter); their constraints[0] is the fn.
        lines.push(`if (!slots[${slotIdx}].constraints[0](object, value)) return;`);
      }
    }

    // (d) Custom validators (CUSTOM_VALIDATION + named built-ins).
    for (const slotIdx of plan.custom) {
      lines.push(`if (${groupChecks[slotIdx]}) {`);
      lines.push(`  if (!${stopGuard}) {`);
      lines.push(`    runtime.runSlot(slots[${slotIdx}], object, value, ${propLit}, ctx, getError);`);
      lines.push(`  }`);
      lines.push(`}`);
    }

    // (e) Nested validation.
    for (const slotIdx of plan.nested) {
      lines.push(`if (${groupChecks[slotIdx]}) {`);
      lines.push(`  if (!${stopGuard}) {`);
      lines.push(`    runtime.runNested(slots[${slotIdx}], object, value, ${propLit}, ctx, getError);`);
      lines.push(`  }`);
      lines.push(`}`);
    }

    return lines;
  }
}

interface PropPlan {
  isDefined: number[];
  conditional: number[];
  custom: number[];
  nested: number[];
  promise: number[];
}
