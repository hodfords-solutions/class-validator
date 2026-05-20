import { ValidationError } from './validation/ValidationError';
import { ValidatorOptions } from './validation/ValidatorOptions';
import { ValidationSchema } from './validation-schema/ValidationSchema';
import { getMetadataStorage } from './metadata/MetadataStorage';
import { Validator } from './validation/Validator';
import { getFromContainer } from './container';

// -------------------------------------------------------------------------
// Export everything api users needs
// -------------------------------------------------------------------------

export * from './container';
export * from './decorator/decorators';
export * from './decorator/ValidationOptions';
export * from './validation/ValidatorConstraintInterface';
export * from './validation/ValidationError';
export * from './validation/ValidatorOptions';
export * from './validation/ValidationArguments';
export * from './validation/ValidationTypes';
export * from './validation/Validator';
export * from './validation-schema/ValidationSchema';
export * from './register-decorator';
export * from './metadata/MetadataStorage';
export { JitCache } from './validation/jit/JitCache';
export { JitCompiler } from './validation/jit/JitCompiler';

// -------------------------------------------------------------------------
// Shortcut methods for api users
// -------------------------------------------------------------------------

/**
 * Validates given object.
 */
export function validate(object: object, validatorOptions?: ValidatorOptions): Promise<ValidationError[]>;

/**
 * Validates given object by a given validation schema.
 */
export function validate(
  schemaName: string,
  object: object,
  validatorOptions?: ValidatorOptions
): Promise<ValidationError[]>;

/**
 * Validates given object by object's decorators or given validation schema.
 */
export function validate(
  schemaNameOrObject: object | string,
  objectOrValidationOptions?: object | ValidatorOptions,
  maybeValidatorOptions?: ValidatorOptions
): Promise<ValidationError[]> {
  if (typeof schemaNameOrObject === 'string') {
    return getFromContainer(Validator).validate(
      schemaNameOrObject,
      objectOrValidationOptions as object,
      maybeValidatorOptions
    );
  } else {
    return getFromContainer(Validator).validate(schemaNameOrObject, objectOrValidationOptions as ValidatorOptions);
  }
}

/**
 * Validates given object and reject on error.
 */
export function validateOrReject(object: object, validatorOptions?: ValidatorOptions): Promise<void>;

/**
 * Validates given object by a given validation schema and reject on error.
 */
export function validateOrReject(
  schemaName: string,
  object: object,
  validatorOptions?: ValidatorOptions
): Promise<void>;

/**
 * Validates given object by object's decorators or given validation schema and reject on error.
 */
export function validateOrReject(
  schemaNameOrObject: object | string,
  objectOrValidationOptions?: object | ValidatorOptions,
  maybeValidatorOptions?: ValidatorOptions
): Promise<void> {
  if (typeof schemaNameOrObject === 'string') {
    return getFromContainer(Validator).validateOrReject(
      schemaNameOrObject,
      objectOrValidationOptions as object,
      maybeValidatorOptions
    );
  } else {
    return getFromContainer(Validator).validateOrReject(
      schemaNameOrObject,
      objectOrValidationOptions as ValidatorOptions
    );
  }
}

/**
 * Performs sync validation of the given object.
 * Note that this method completely ignores async validations.
 * If you want to properly perform validation you need to call validate method instead.
 */
export function validateSync(object: object, validatorOptions?: ValidatorOptions): ValidationError[];

/**
 * Validates given object by a given validation schema.
 * Note that this method completely ignores async validations.
 * If you want to properly perform validation you need to call validate method instead.
 */
export function validateSync(
  schemaName: string,
  object: object,
  validatorOptions?: ValidatorOptions
): ValidationError[];

/**
 * Validates given object by object's decorators or given validation schema.
 * Note that this method completely ignores async validations.
 * If you want to properly perform validation you need to call validate method instead.
 */
export function validateSync(
  schemaNameOrObject: object | string,
  objectOrValidationOptions?: object | ValidatorOptions,
  maybeValidatorOptions?: ValidatorOptions
): ValidationError[] {
  if (typeof schemaNameOrObject === 'string') {
    return getFromContainer(Validator).validateSync(
      schemaNameOrObject,
      objectOrValidationOptions as object,
      maybeValidatorOptions
    );
  } else {
    return getFromContainer(Validator).validateSync(schemaNameOrObject, objectOrValidationOptions as ValidatorOptions);
  }
}

/**
 * Validates a plain object against the decorators of the supplied class
 * without first transforming it into a class instance. Useful when callers
 * (e.g. HTTP request handlers) just need to verify a payload's shape and want
 * to skip the cost of plainToInstance.
 */
export function validatePlain<T extends object>(
  object: object,
  classObject: new (...args: any[]) => T,
  validatorOptions?: ValidatorOptions
): Promise<ValidationError[]> {
  return getFromContainer(Validator).validatePlain(object, classObject, validatorOptions);
}

/**
 * Synchronous variant of {@link validatePlain} — ignores async constraints.
 */
export function validatePlainSync<T extends object>(
  object: object,
  classObject: new (...args: any[]) => T,
  validatorOptions?: ValidatorOptions
): ValidationError[] {
  return getFromContainer(Validator).validatePlainSync(object, classObject, validatorOptions);
}

/**
 * Promise-rejecting variant of {@link validatePlain}.
 */
export function validatePlainOrReject<T extends object>(
  object: object,
  classObject: new (...args: any[]) => T,
  validatorOptions?: ValidatorOptions
): Promise<void> {
  return getFromContainer(Validator).validatePlainOrReject(object, classObject, validatorOptions);
}

/**
 * Registers a new validation schema.
 */
export function registerSchema(schema: ValidationSchema): void {
  getMetadataStorage().addValidationSchema(schema);
}
