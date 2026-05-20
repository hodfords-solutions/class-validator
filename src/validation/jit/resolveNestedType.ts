/**
 * Best-effort resolution of the runtime class for a nested property — used by
 * `validatePlain` so plain (non-instance) nested values still dispatch to the
 * correct compiled validator.
 *
 * Resolution order:
 *   1) class-transformer's `@Type()` metadata, if class-transformer is loaded.
 *   2) TypeScript's `design:type` reflect-metadata, if `reflect-metadata` is
 *      polyfilled and the property is non-collection (Array/Set/Map are too
 *      coarse to be useful — callers must use `@Type()` for those).
 *
 * Returns `undefined` if no usable type can be resolved; callers should fall
 * back to `value.constructor`.
 */
let _ctStorageResolved = false;
let _ctStorage: any;

function getClassTransformerStorage(): any {
  if (_ctStorageResolved) return _ctStorage;
  _ctStorageResolved = true;
  for (const modPath of ['class-transformer/cjs/storage', 'class-transformer']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(modPath);
      const candidate = mod && (mod.defaultMetadataStorage || (mod.default && mod.default.defaultMetadataStorage));
      if (candidate && typeof candidate.findTypeMetadata === 'function') {
        _ctStorage = candidate;
        return _ctStorage;
      }
    } catch {
      // ignore — class-transformer is optional
    }
  }
  return undefined;
}

export function resolveNestedType(target: Function, propertyName: string): Function | undefined {
  const storage = getClassTransformerStorage();
  if (storage) {
    try {
      const meta = storage.findTypeMetadata(target, propertyName);
      if (meta && typeof meta.typeFunction === 'function') {
        const resolved = meta.typeFunction();
        if (typeof resolved === 'function') return resolved;
      }
    } catch {
      // ignore
    }
  }

  // reflect-metadata fallback — only useful for non-collection properties.
  const Reflect: any = (globalThis as any).Reflect;
  if (Reflect && typeof Reflect.getMetadata === 'function') {
    try {
      const designType = Reflect.getMetadata('design:type', target.prototype, propertyName);
      if (
        typeof designType === 'function' &&
        designType !== Object &&
        designType !== Array &&
        designType !== Set &&
        designType !== Map &&
        designType !== Promise
      ) {
        return designType;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}
