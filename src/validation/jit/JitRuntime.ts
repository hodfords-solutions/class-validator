import { ValidationError } from '../ValidationError';
import { ValidationArguments } from '../ValidationArguments';
import { ValidationUtils } from '../ValidationUtils';
import { ValidatorOptions } from '../ValidatorOptions';
import { isPromise, convertToArray } from '../../utils';

/**
 * Shared runtime context passed to every compiled validator invocation.
 * Holds state that needs to span nested calls (async promises, the dispatch
 * function for recursive validation, and the options + ignoreAsync flag).
 */
export interface JitRuntimeContext {
  validatorOptions: ValidatorOptions | undefined;
  awaitingPromises: Promise<any>[];
  ignoreAsync: boolean;
  /**
   * Validates a nested object by looking up (and compiling on demand) the
   * validator for its runtime constructor, then pushing the resulting errors
   * into `errors`. When `explicitType` is supplied (compile-time resolved
   * nested type for plain validation), it is preferred over
   * `object.constructor`.
   */
  dispatchNested: (
    object: any,
    errors: ValidationError[],
    ctx: JitRuntimeContext,
    explicitType?: Function
  ) => void;
}

/**
 * The signature of a compiled validator. The compiled function appends errors
 * to the provided array (lazy — only when constraints fail or nested children
 * exist) and pushes async work into `ctx.awaitingPromises`.
 */
export type CompiledValidator = (object: any, errors: ValidationError[], ctx: JitRuntimeContext) => void;

/**
 * Slot bound at compile time for a single validation metadata entry.
 * Generated code references these by index to keep the emitted source small
 * and avoid string-quoting closures.
 */
export interface ValidationSlot {
  /** Pre-resolved constraint validate(value, args) callable (custom validators only). */
  validateFn?: (value: any, args: ValidationArguments) => boolean | Promise<boolean>;
  /** Pre-resolved defaultMessage callable (custom validators only). */
  defaultMessageFn?: (args: ValidationArguments) => string;
  /** Effective error type ("constraint key" in ValidationError.constraints). */
  type: string;
  /** Custom message from decorator options (may be string or function). */
  message: string | ((args: ValidationArguments) => string) | undefined;
  /** Raw `constraints` array from the metadata (passed into ValidationArguments). */
  constraints: any[];
  /** `each: true` — value must be Array/Set/Map and each item is validated. */
  each: boolean;
  /** Async-capable constraint. */
  async: boolean;
  /** Per-metadata ValidateIf predicate (decorator option). */
  validateIfFn?: (object: any, value: any) => boolean;
  /** Transient context object to attach when this constraint fails. */
  context?: any;
  /** Predicate that determines if this metadata applies given runtime options. */
  groupApplies: (options: ValidatorOptions | undefined) => boolean;
  /**
   * Resolved nested target class (NESTED_VALIDATION slots only). Set at
   * compile time when class-transformer `@Type()` or reflect-metadata
   * `design:type` exposes it, so plain nested values dispatch to the right
   * compiled validator instead of relying on `value.constructor === Object`.
   */
  nestedType?: Function;
}

/**
 * Build the ValidationArguments object expected by user-supplied message
 * functions and validators.
 */
export function makeValidationArguments(object: any, value: any, property: string, constraints: any[]): ValidationArguments {
  return {
    targetName: object && object.constructor ? (object.constructor as any).name : undefined,
    property,
    object,
    value,
    constraints,
  };
}

/**
 * Mutable per-property accumulator. The compiler stamps one of these into a
 * function-local at the top of each property block, then passes it to slot
 * runners.
 */
export interface ErrorRef {
  error: ValidationError | undefined;
}

/**
 * Lazily allocate a ValidationError for a property — generated code calls this
 * the first time a constraint fails (or a nested child is produced) so we
 * avoid creating throw-away error objects for properties that pass.
 */
export function ensureError(
  errorRef: ErrorRef,
  errors: ValidationError[],
  object: any,
  value: any,
  property: string,
  options: ValidatorOptions | undefined
): ValidationError {
  if (errorRef.error) return errorRef.error;
  const e = new ValidationError();
  if (!options || !options.validationError || options.validationError.target === undefined || options.validationError.target === true) {
    e.target = object;
  }
  if (!options || !options.validationError || options.validationError.value === undefined || options.validationError.value === true) {
    e.value = value;
  }
  e.property = property;
  e.children = [];
  e.constraints = {};
  errorRef.error = e;
  errors.push(e);
  return e;
}

/**
 * Resolve an error message (decorator `message`, falling back to the
 * constraint's defaultMessage when not dismissed by ValidatorOptions).
 */
export function resolveMessage(slot: ValidationSlot, args: ValidationArguments, options: ValidatorOptions | undefined): string {
  let message: any = slot.message || '';
  if (!slot.message && (!options || !options.dismissDefaultMessages)) {
    if (slot.defaultMessageFn) {
      message = slot.defaultMessageFn(args);
    }
  }
  return ValidationUtils.replaceMessageSpecialTokens(message, args);
}

/**
 * Attach the slot's transient context object to the error under the failed
 * constraint type, mirroring ValidationExecutor#mapContexts.
 */
export function attachContext(error: ValidationError, slot: ValidationSlot): void {
  if (slot.context && error.constraints && error.constraints[slot.type]) {
    if (!error.contexts) error.contexts = {};
    error.contexts[slot.type] = Object.assign(error.contexts[slot.type] || {}, slot.context);
  }
}

/**
 * Run a single sync/async custom constraint slot against `value`. If async,
 * push the promise into ctx.awaitingPromises so the top-level validate()
 * can await it. Returns nothing — failure is recorded into the error object
 * created lazily through `getError`.
 */
export function runSlot(
  slot: ValidationSlot,
  object: any,
  value: any,
  property: string,
  ctx: JitRuntimeContext,
  getError: () => ValidationError
): void {
  const options = ctx.validatorOptions;
  if (slot.async && ctx.ignoreAsync) return;
  if (slot.validateIfFn && !slot.validateIfFn(object, value)) return;

  // each: true — apply per-item over Array/Set/Map
  if (slot.each && (Array.isArray(value) || value instanceof Set || value instanceof Map)) {
    const arr = convertToArray(value);
    const subResults: any[] = new Array(arr.length);
    let anyAsync = false;
    for (let i = 0; i < arr.length; i++) {
      const args = makeValidationArguments(object, value, property, slot.constraints);
      const r = slot.validateFn!(arr[i], args);
      if (isPromise(r)) anyAsync = true;
      subResults[i] = r;
    }
    if (anyAsync) {
      const promised = subResults.map((r: any) => (isPromise(r) ? r : Promise.resolve(r)));
      ctx.awaitingPromises.push(
        Promise.all(promised).then((results: boolean[]) => {
          if (!results.every(Boolean)) {
            const args = makeValidationArguments(object, value, property, slot.constraints);
            const msg = resolveMessage(slot, args, options);
            const err = getError();
            err.constraints[slot.type] = msg;
            attachContext(err, slot);
          }
        })
      );
      return;
    }
    if (!subResults.every(Boolean)) {
      const args = makeValidationArguments(object, value, property, slot.constraints);
      const msg = resolveMessage(slot, args, options);
      const err = getError();
      err.constraints[slot.type] = msg;
      attachContext(err, slot);
    }
    return;
  }

  // single value
  const args = makeValidationArguments(object, value, property, slot.constraints);
  const result = slot.validateFn!(value, args);
  if (isPromise(result)) {
    ctx.awaitingPromises.push(
      result.then((isValid: boolean) => {
        if (!isValid) {
          const msg = resolveMessage(slot, args, options);
          const err = getError();
          err.constraints[slot.type] = msg;
          attachContext(err, slot);
        }
      })
    );
    return;
  }
  if (!result) {
    const msg = resolveMessage(slot, args, options);
    const err = getError();
    err.constraints[slot.type] = msg;
    attachContext(err, slot);
  }
}

/**
 * Record the IS_DEFINED constraint failure (special-cased: runs even when
 * skipUndefinedProperties / skipNullProperties / skipMissingProperties are
 * set). The slot has no validate function — failure is detected purely by
 * value === undefined || value === null.
 */
export function runIsDefined(
  slot: ValidationSlot,
  object: any,
  value: any,
  property: string,
  ctx: JitRuntimeContext,
  getError: () => ValidationError
): void {
  if (slot.validateIfFn && !slot.validateIfFn(object, value)) return;
  if (value !== undefined && value !== null) return;
  const args = makeValidationArguments(object, value, property, slot.constraints);
  const msg = resolveMessage(slot, args, ctx.validatorOptions);
  const err = getError();
  err.constraints[slot.type] = msg;
  attachContext(err, slot);
}

/**
 * Handle a NESTED_VALIDATION slot — recurse into the value (object, array,
 * Set, Map). For non-object values, record the nested-validation failure
 * message on the property.
 *
 * Arrays of arrays (and Set/Map of arrays) recurse with the SAME slot so we
 * can drill down through any depth — mirroring the legacy executor, which
 * re-enters performValidations for each level.
 */
export function runNested(
  slot: ValidationSlot,
  object: any,
  value: any,
  property: string,
  ctx: JitRuntimeContext,
  getError: () => ValidationError
): void {
  if (value === undefined) return;
  if (Array.isArray(value) || value instanceof Set || value instanceof Map) {
    const isMap = value instanceof Map;
    const arrayLikeValue: any = value instanceof Set ? Array.from(value) : value;
    const parentErr = getError();
    const options = ctx.validatorOptions;
    arrayLikeValue.forEach((subValue: any, indexOrKey: any) => {
      const childErr = new ValidationError();
      if (!options || !options.validationError || options.validationError.target === undefined || options.validationError.target === true) {
        childErr.target = value;
      }
      if (!options || !options.validationError || options.validationError.value === undefined || options.validationError.value === true) {
        childErr.value = subValue;
      }
      childErr.property = isMap ? String(indexOrKey) : indexOrKey.toString();
      childErr.constraints = {};
      childErr.children = [];
      parentErr.children.push(childErr);

      // Apply skip*-properties options to each item.
      if (subValue === undefined && options && options.skipUndefinedProperties === true) return;
      if (subValue === null && options && options.skipNullProperties === true) return;
      if ((subValue === null || subValue === undefined) && options && options.skipMissingProperties === true) return;

      // Recurse with the same slot — arrays / Sets / Maps of arrays drill
      // down level-by-level until we reach an object (or primitive).
      runNested(slot, value, subValue, childErr.property, ctx, () => childErr);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    const err = getError();
    ctx.dispatchNested(value, err.children, ctx, slot.nestedType);
    return;
  }
  // primitive — error
  const args = makeValidationArguments(object, value, property, slot.constraints);
  const msg = resolveMessage(slot, args, ctx.validatorOptions);
  const err = getError();
  err.constraints[slot.type] = msg;
}

/**
 * Build an "unknown value" validation error used when forbidUnknownValues
 * triggers because the target class has no registered metadata.
 */
export function makeUnknownValueError(object: any, options: ValidatorOptions | undefined): ValidationError {
  const e = new ValidationError();
  if (!options || !options.validationError || options.validationError.target === undefined || options.validationError.target === true) {
    e.target = object;
  }
  e.value = undefined;
  e.property = undefined;
  e.children = [];
  e.constraints = { unknownValue: 'an unknown value was passed to the validate function' };
  return e;
}

/**
 * Handle whitelist / forbidNonWhitelisted on a target object. `knownProps` is
 * the precomputed set of decorated property names for the class (built once
 * at compile time).
 */
export function handleWhitelist(
  object: any,
  knownProps: Set<string>,
  options: ValidatorOptions | undefined,
  errors: ValidationError[]
): void {
  const notAllowed: string[] = [];
  for (const prop in object) {
    if (!knownProps.has(prop)) notAllowed.push(prop);
  }
  if (!notAllowed.length) return;
  if (options && options.forbidNonWhitelisted) {
    for (const prop of notAllowed) {
      const e = new ValidationError();
      if (!options.validationError || options.validationError.target === undefined || options.validationError.target === true) {
        e.target = object;
      }
      if (!options.validationError || options.validationError.value === undefined || options.validationError.value === true) {
        e.value = object[prop];
      }
      e.property = prop;
      e.constraints = { whitelistValidation: `property ${prop} should not exist` };
      errors.push(e);
    }
  } else {
    for (const prop of notAllowed) delete object[prop];
  }
}

/**
 * Mirrors ValidationExecutor.stripEmptyErrors — removes errors with empty
 * constraints and no children (post-order recursion).
 */
export function stripEmptyErrors(errors: ValidationError[]): ValidationError[] {
  return errors.filter(error => {
    if (error.children) {
      error.children = stripEmptyErrors(error.children);
    }
    if (Object.keys(error.constraints || {}).length === 0) {
      if (!error.children || error.children.length === 0) return false;
      delete error.constraints;
    }
    return true;
  });
}
