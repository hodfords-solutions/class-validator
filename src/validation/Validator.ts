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
    const schema = typeof objectOrSchemaName === 'string' ? (objectOrSchemaName as string) : undefined;

    const errors = this.runJit(object, schema, options, /* ignoreAsync */ true);
    return stripEmptyErrors(errors);
  }

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
    const schema = typeof objectOrSchemaName === 'string' ? (objectOrSchemaName as string) : undefined;

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
}
