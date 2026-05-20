import { ValidationError } from './ValidationError';
import { ValidatorOptions } from './ValidatorOptions';
import { ValidationExecutor } from './ValidationExecutor';
import { ValidationOptions } from '../decorator/ValidationOptions';
import { JitCache } from './jit/JitCache';
import { stripEmptyErrors } from './jit/JitRuntime';
import { getMetadataStorage } from '../metadata/MetadataStorage';

/**
 * Validator performs validation of the given object based on its metadata.
 *
 * As of 0.16, this dispatches through a JIT-compiled per-class validator
 * function (see {@link JitCache}). The legacy {@link ValidationExecutor} is
 * kept for parity testing and for the rare case where a runtime feature
 * isn't supported by the compiler.
 */
export class Validator {
  // -------------------------------------------------------------------------
  // Private Properties
  // -------------------------------------------------------------------------

  /** Lazily-built per-Validator JIT cache. */
  private _jitCache: JitCache | undefined;

  private get jitCache(): JitCache {
    if (!this._jitCache) {
      this._jitCache = new JitCache(getMetadataStorage());
    }
    return this._jitCache;
  }

  // -------------------------------------------------------------------------
  // Public Methods
  // -------------------------------------------------------------------------

  /**
   * Performs validation of the given object based on decorators used in given object class.
   */
  validate(object: object, options?: ValidatorOptions): Promise<ValidationError[]>;

  /**
   * Performs validation of the given object based on validation schema.
   */
  validate(schemaName: string, object: object, options?: ValidatorOptions): Promise<ValidationError[]>;

  /**
   * Performs validation of the given object based on decorators or validation schema.
   */
  validate(
    objectOrSchemaName: object | string,
    objectOrValidationOptions: object | ValidationOptions,
    maybeValidatorOptions?: ValidatorOptions
  ): Promise<ValidationError[]> {
    return this.coreValidate(objectOrSchemaName, objectOrValidationOptions, maybeValidatorOptions);
  }

  /**
   * Performs validation of the given object based on decorators used in given object class and reject on error.
   */
  validateOrReject(object: object, options?: ValidatorOptions): Promise<void>;

  /**
   * Performs validation of the given object based on validation schema and reject on error.
   */
  validateOrReject(schemaName: string, object: object, options?: ValidatorOptions): Promise<void>;

  /**
   * Performs validation of the given object based on decorators or validation schema and reject on error.
   */
  async validateOrReject(
    objectOrSchemaName: object | string,
    objectOrValidationOptions: object | ValidationOptions,
    maybeValidatorOptions?: ValidatorOptions
  ): Promise<void> {
    const errors = await this.coreValidate(objectOrSchemaName, objectOrValidationOptions, maybeValidatorOptions);
    if (errors.length) return Promise.reject(errors);
  }

  /**
   * Performs validation of the given plain object against the decorators of
   * the supplied class. Unlike {@link validate}, the plain object is used
   * directly (no plainToInstance step) — useful when callers only need to
   * validate the shape of an already-deserialised payload (e.g. an HTTP body)
   * without the overhead of constructing class instances.
   *
   * For nested validation, the runtime resolves the nested class via the
   * class-transformer `@Type()` decorator (when class-transformer is installed)
   * or via `Reflect.getMetadata('design:type', …)` (when reflect-metadata is
   * polyfilled). Otherwise the nested object's own constructor is used.
   */
  validatePlain<T extends object>(
    object: object,
    classObject: new (...args: any[]) => T,
    options?: ValidatorOptions
  ): Promise<ValidationError[]> {
    const ctx = this.jitCache.buildContext(options, false);
    const errors = this.runJitPlain(classObject, object, options, false, ctx);
    return Promise.all(ctx.awaitingPromises).then(() => stripEmptyErrors(errors));
  }

  /**
   * Synchronous variant of {@link validatePlain}. Ignores async constraints.
   */
  validatePlainSync<T extends object>(
    object: object,
    classObject: new (...args: any[]) => T,
    options?: ValidatorOptions
  ): ValidationError[] {
    const errors = this.runJitPlain(classObject, object, options, true);
    return stripEmptyErrors(errors);
  }

  /**
   * Promise-rejecting variant of {@link validatePlain}.
   */
  async validatePlainOrReject<T extends object>(
    object: object,
    classObject: new (...args: any[]) => T,
    options?: ValidatorOptions
  ): Promise<void> {
    const errors = await this.validatePlain(object, classObject, options);
    if (errors.length) return Promise.reject(errors);
  }

  /**
   * Performs validation of the given object based on decorators used in given object class.
   * NOTE: This method completely ignores all async validations.
   */
  validateSync(object: object, options?: ValidatorOptions): ValidationError[];

  /**
   * Performs validation of the given object based on validation schema.
   */
  validateSync(schemaName: string, object: object, options?: ValidatorOptions): ValidationError[];

  /**
   * Performs validation of the given object based on decorators or validation schema.
   */
  validateSync(
    objectOrSchemaName: object | string,
    objectOrValidationOptions: object | ValidationOptions,
    maybeValidatorOptions?: ValidatorOptions
  ): ValidationError[] {
    const object = typeof objectOrSchemaName === 'string' ? (objectOrValidationOptions as object) : objectOrSchemaName;
    const options =
      typeof objectOrSchemaName === 'string' ? maybeValidatorOptions : (objectOrValidationOptions as ValidationOptions);
    const schema = typeof objectOrSchemaName === 'string' ? objectOrSchemaName : undefined;

    const errors = this.runJit(object, schema, options, /* ignoreAsync */ true);
    return stripEmptyErrors(errors);
  }

  /**
   * Performs validation of the given object based on decorators or validation schema.
   * Common method for `validateOrReject` and `validate` methods.
   */
  private coreValidate(
    objectOrSchemaName: object | string,
    objectOrValidationOptions: object | ValidationOptions,
    maybeValidatorOptions?: ValidatorOptions
  ): Promise<ValidationError[]> {
    const object = typeof objectOrSchemaName === 'string' ? (objectOrValidationOptions as object) : objectOrSchemaName;
    const options =
      typeof objectOrSchemaName === 'string' ? maybeValidatorOptions : (objectOrValidationOptions as ValidationOptions);
    const schema = typeof objectOrSchemaName === 'string' ? objectOrSchemaName : undefined;

    const ctx = this.jitCache.buildContext(options, false);
    const errors = this.runJit(object, schema, options, false, ctx);
    return Promise.all(ctx.awaitingPromises).then(() => stripEmptyErrors(errors));
  }

  /**
   * Run the compiled validator for `object` (or `schema`). Falls back to the
   * legacy {@link ValidationExecutor} only if the JIT compiler can't be used
   * (currently: never — but we keep the seam for safety).
   */
  private runJit(
    object: any,
    schema: string | undefined,
    options: ValidatorOptions | undefined,
    ignoreAsync: boolean,
    sharedCtx?: ReturnType<JitCache['buildContext']>
  ): ValidationError[] {
    if (object == null || typeof object !== 'object') {
      // Mirrors legacy executor: forbidUnknownValues triggers an error,
      // otherwise (forbidUnknownValues=false) we have nothing to do. The
      // compiler-generated function will handle both cases when given a
      // target with no metadata; but if `object` itself isn't an object,
      // route to the legacy executor for compatibility.
      const executor = new ValidationExecutor(this, options);
      executor.ignoreAsyncValidations = ignoreAsync;
      const errs: ValidationError[] = [];
      executor.execute(object, schema, errs);
      if (sharedCtx) for (const p of executor.awaitingPromises) sharedCtx.awaitingPromises.push(p);
      return errs;
    }

    const target: Function | string = schema ? schema : object.constructor;
    const fn = this.jitCache.get(target);
    const ctx = sharedCtx || this.jitCache.buildContext(options, ignoreAsync);
    const errors: ValidationError[] = [];
    fn(object, errors, ctx);
    return errors;
  }

  /**
   * Run the compiled validator for `object` against an explicit class target.
   * Skips the `object.constructor` lookup used by {@link runJit} so plain
   * objects can be validated without going through plainToInstance first.
   */
  private runJitPlain(
    classObject: Function,
    object: any,
    options: ValidatorOptions | undefined,
    ignoreAsync: boolean,
    sharedCtx?: ReturnType<JitCache['buildContext']>
  ): ValidationError[] {
    if (object == null || typeof object !== 'object') {
      const executor = new ValidationExecutor(this, options);
      executor.ignoreAsyncValidations = ignoreAsync;
      const errs: ValidationError[] = [];
      executor.execute(object, undefined, errs);
      if (sharedCtx) for (const p of executor.awaitingPromises) sharedCtx.awaitingPromises.push(p);
      return errs;
    }

    const fn = this.jitCache.get(classObject);
    const ctx = sharedCtx || this.jitCache.buildContext(options, ignoreAsync);
    const errors: ValidationError[] = [];
    fn(object, errors, ctx);
    return errors;
  }
}
