/**
 * Microbenchmark comparing the JIT-compiled validator (new in 0.16) against
 * the legacy {@link ValidationExecutor} interpreter on a realistic shape
 * (mix of built-ins, nested objects, arrays, conditional, validateIf).
 *
 * Run with: npx ts-node sample/benchmark/benchmark.ts
 */
import 'reflect-metadata';
import {
  IsString,
  IsEmail,
  Length,
  Min,
  Max,
  IsInt,
  IsOptional,
  ValidateNested,
  IsArray,
  ArrayMinSize,
  IsDefined,
  ValidateIf,
} from '../../src/decorator/decorators';
import { Validator } from '../../src/validation/Validator';
import { ValidationExecutor } from '../../src/validation/ValidationExecutor';
import { ValidationError } from '../../src/validation/ValidationError';

class Address {
  @IsString()
  @Length(1, 120)
  street!: string;

  @IsString()
  @Length(2, 60)
  city!: string;

  @IsString()
  @Length(2, 12)
  zip!: string;
}

class Order {
  @IsInt()
  @Min(1)
  id!: number;

  @IsInt()
  @Min(0)
  @Max(100_000)
  amountCents!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

class User {
  @IsDefined()
  @IsInt()
  id!: number;

  @IsString()
  @Length(2, 60)
  name!: string;

  @IsEmail()
  email!: string;

  @ValidateIf((_, v) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(130)
  age?: number;

  @ValidateNested()
  address!: Address;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  orders!: Order[];
}

function makeUser(): User {
  const u = new User();
  u.id = 1;
  u.name = 'Alice';
  u.email = 'alice@example.com';
  u.age = 30;
  const a = new Address();
  a.street = '123 Elm';
  a.city = 'Hanoi';
  a.zip = '10000';
  u.address = a;
  u.orders = Array.from({ length: 5 }, (_, i) => {
    const o = new Order();
    o.id = i + 1;
    o.amountCents = (i + 1) * 1000;
    o.note = i % 2 ? 'gift' : undefined;
    return o;
  });
  return u;
}

const validator = new Validator();

function runInterpreter(user: User): ValidationError[] {
  const exec = new ValidationExecutor(validator, undefined);
  exec.ignoreAsyncValidations = true;
  const errors: ValidationError[] = [];
  exec.execute(user, undefined as any, errors);
  return exec.stripEmptyErrors(errors);
}

function runJit(user: User): ValidationError[] {
  return validator.validateSync(user);
}

function bench(label: string, fn: () => void, iters: number): number {
  // Warm up.
  for (let i = 0; i < 1000; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  const opsPerSec = (iters / ms) * 1000;
  console.log(`  ${label.padEnd(20)} ${ms.toFixed(1)} ms total, ${opsPerSec.toFixed(0)} ops/s`);
  return ms;
}

function main(): void {
  const valid = makeUser();
  const invalid = makeUser();
  invalid.email = 'not-an-email';
  invalid.orders[2].amountCents = -1;
  invalid.address.zip = '!';

  // Verify outputs match between paths (sanity check).
  const interpreterErrors = runInterpreter(valid);
  const jitErrors = runJit(valid);
  if (interpreterErrors.length !== jitErrors.length) {
    console.error('parity mismatch on valid:', interpreterErrors, jitErrors);
    process.exit(1);
  }
  const i2 = runInterpreter(invalid);
  const j2 = runJit(invalid);
  if (i2.length !== j2.length) {
    console.error('parity mismatch on invalid:', i2.length, j2.length);
    process.exit(1);
  }

  const ITERS = 50_000;
  console.log(`\nValid object (${ITERS.toLocaleString()} iterations):`);
  const tInterp = bench('Interpreter', () => runInterpreter(valid), ITERS);
  const tJit = bench('JIT', () => runJit(valid), ITERS);
  console.log(`  → Speedup: ${(tInterp / tJit).toFixed(2)}x`);

  console.log(`\nInvalid object (${ITERS.toLocaleString()} iterations):`);
  const tInterp2 = bench('Interpreter', () => runInterpreter(invalid), ITERS);
  const tJit2 = bench('JIT', () => runJit(invalid), ITERS);
  console.log(`  → Speedup: ${(tInterp2 / tJit2).toFixed(2)}x`);
}

main();
