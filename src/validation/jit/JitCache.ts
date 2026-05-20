import { MetadataStorage } from '../../metadata/MetadataStorage';
import { ValidationError } from '../ValidationError';
import { JitCompiler } from './JitCompiler';
import { CompiledValidator, JitRuntimeContext } from './JitRuntime';

interface CacheEntry {
  version: number;
  fn: CompiledValidator;
}

/**
 * Cache of compiled validator functions keyed by target constructor (or
 * schema name). Entries are invalidated automatically when MetadataStorage
 * advertises a higher version than the one captured at compile time.
 */
export class JitCache {
  private classCache = new WeakMap<Function, CacheEntry>();
  private schemaCache = new Map<string, CacheEntry>();
  private compiler: JitCompiler;

  constructor(private metadataStorage: MetadataStorage) {
    this.compiler = new JitCompiler(metadataStorage);
  }

  /**
   * Get (compiling if needed) the validator for `target`. `target` may be a
   * class constructor or a schema name.
   */
  get(target: Function | string): CompiledValidator {
    const version = this.metadataStorage.version;

    if (typeof target === 'string') {
      const hit = this.schemaCache.get(target);
      if (hit && hit.version === version) return hit.fn;
      const fn = this.compiler.compile(target);
      this.schemaCache.set(target, { version, fn });
      return fn;
    }

    const hit = this.classCache.get(target);
    if (hit && hit.version === version) return hit.fn;
    const fn = this.compiler.compile(target);
    this.classCache.set(target, { version, fn });
    return fn;
  }

  /**
   * Build the JitRuntimeContext used for a single top-level validate() call.
   * `dispatchNested` lets the runtime recurse into nested object validation
   * by looking up the compiled fn for the nested value's runtime class.
   */
  buildContext(options: any, ignoreAsync: boolean): JitRuntimeContext {
    const cache = this;
    const ctx: JitRuntimeContext = {
      validatorOptions: options,
      awaitingPromises: [],
      ignoreAsync,
      dispatchNested(
        nestedObject: any,
        errors: ValidationError[],
        c: JitRuntimeContext,
        explicitType?: Function
      ): void {
        // Prefer the compile-time resolved nested type — required when
        // validating plain objects whose `constructor` is just `Object`.
        const ctor = explicitType || nestedObject.constructor;
        const fn = cache.get(ctor);
        fn(nestedObject, errors, c);
      },
    };
    return ctx;
  }
}
