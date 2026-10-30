import type { SecureCustomField } from './model';
import { preserveUneditedProjection } from './edited-projection';

const normalize = (field: SecureCustomField): SecureCustomField => {
  const fieldType = field.fieldType || (field.protected ? 'HIDDEN' : 'TEXT');
  return { ...field, fieldType, protected: fieldType === 'HIDDEN' };
};

/** Track each occurrence by draft identity, never by its possibly duplicate name. */
export function createSecureCustomFieldEditor({ normalizeTypes = true } = {}) {
  // Wallets expose a type selector; password forms use the protection flag.
  const project = normalizeTypes ? normalize : (field: SecureCustomField) => ({ ...field });
  const originals = new WeakMap<SecureCustomField, { original: SecureCustomField; baseline: SecureCustomField }>();
  return {
    draft(original: SecureCustomField): SecureCustomField {
      const baseline = project(original), draft = { ...baseline };
      originals.set(draft, { original, baseline });
      return draft;
    },
    serialize(drafts: readonly SecureCustomField[], { validate = true } = {}): SecureCustomField[] {
      return drafts.flatMap(draft => {
        const source = originals.get(draft);
        if (!draft.name.trim()) {
          // A legacy unnamed row is source data, not an empty new editor row.
          if (!source && !draft.value) return [];
          if (validate && (!source || draft.name !== source.original.name)) throw new Error('请输入自定义字段名称。');
        }
        const value = project(draft);
        if (!source) return [value];
        const merged = preserveUneditedProjection(source.original, source.baseline, value);
        // An explicit type choice also chooses the corresponding protection.
        return [value.fieldType === source.baseline.fieldType ? merged : { ...merged, protected: value.protected }];
      });
    }
  };
}
