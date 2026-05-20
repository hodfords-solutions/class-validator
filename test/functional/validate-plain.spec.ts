import { IsString, MinLength, IsInt, Min, ValidateNested } from '../../src/decorator/decorators';
import { Validator } from '../../src/validation/Validator';
import { validatePlain, validatePlainSync, validatePlainOrReject } from '../../src/index';

const validator = new Validator();

describe('validatePlain', () => {
  class UserDto {
    @IsString()
    @MinLength(3)
    name: string;

    @IsInt()
    @Min(0)
    age: number;
  }

  it('should validate a plain object against the supplied class', async () => {
    const errors = await validator.validatePlain({ name: 'John', age: 30 }, UserDto);
    expect(errors).toEqual([]);
  });

  it('should report errors on a failing plain object without transforming first', async () => {
    const errors = await validator.validatePlain({ name: 'Jo', age: -1 }, UserDto);
    expect(errors).toHaveLength(2);
    const props = errors.map(e => e.property).sort();
    expect(props).toEqual(['age', 'name']);
  });

  it('should expose a sync variant that ignores async validators', () => {
    const errors = validator.validatePlainSync({ name: 'a', age: 0 }, UserDto);
    const nameErr = errors.find(e => e.property === 'name')!;
    expect(nameErr.constraints).toHaveProperty('minLength');
  });

  it('should reject via validatePlainOrReject on failure', async () => {
    await expect(validator.validatePlainOrReject({ name: '', age: 'x' as any }, UserDto)).rejects.toBeDefined();
  });

  it('should resolve via validatePlainOrReject on success', async () => {
    await expect(validator.validatePlainOrReject({ name: 'John', age: 42 }, UserDto)).resolves.toBeUndefined();
  });

  it('should not require the plain object to be an instance of the class', async () => {
    const plain = Object.create(null);
    plain.name = 'John';
    plain.age = 25;
    const errors = await validator.validatePlain(plain, UserDto);
    expect(errors).toEqual([]);
  });

  it('should expose top-level shortcut helpers', async () => {
    const okErrors = await validatePlain({ name: 'John', age: 30 }, UserDto);
    expect(okErrors).toEqual([]);

    const badErrors = validatePlainSync({ name: 'x', age: -1 }, UserDto);
    expect(badErrors.length).toBeGreaterThan(0);

    await expect(validatePlainOrReject({ name: 'x', age: -1 }, UserDto)).rejects.toBeDefined();
  });

  it('should respect validator options (groups)', async () => {
    class WithGroups {
      @IsString({ groups: ['create'] })
      a: string;

      @IsString({ groups: ['update'] })
      b: string;
    }

    const errs = await validator.validatePlain({}, WithGroups, { groups: ['create'] });
    expect(errs).toHaveLength(1);
    expect(errs[0].property).toBe('a');
  });
});

describe('validatePlain nested validation', () => {
  it('should dispatch nested validation using the explicit type provider', async () => {
    class Address {
      @IsString()
      @MinLength(2)
      city: string;
    }

    class Person {
      @IsString()
      name: string;

      @ValidateNested()
      address: Address;
    }

    // Mutate the metadata to pin the nested type — exercises the
    // `validationTypeOptions.type` escape hatch that buildSlot honours.
    const storage = (require('../../src/metadata/MetadataStorage') as any).getMetadataStorage();
    for (const arr of storage['validationMetadatas'].values()) {
      for (const m of arr) {
        if (m.target === Person && m.propertyName === 'address') {
          m.validationTypeOptions = { type: () => Address };
        }
      }
    }
    // Bump version so JIT cache compiles a fresh validator that sees the
    // updated validationTypeOptions.
    storage['_version'] = (storage['_version'] || 0) + 1;

    const okErrors = await validator.validatePlain({ name: 'John', address: { city: 'NYC' } }, Person);
    expect(okErrors).toEqual([]);

    const badErrors = await validator.validatePlain({ name: 'John', address: { city: 'a' } }, Person);
    expect(badErrors).toHaveLength(1);
    expect(badErrors[0].property).toBe('address');
    expect(badErrors[0].children).toHaveLength(1);
    expect(badErrors[0].children[0].property).toBe('city');
  });
});
