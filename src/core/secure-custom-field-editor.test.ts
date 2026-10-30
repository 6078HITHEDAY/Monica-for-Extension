import { expect, it } from 'vitest';
import { createSecureCustomFieldEditor } from './secure-custom-field-editor';
import type { SecureCustomField } from './model';

it('keeps password form inputs verbatim without adding a wallet field type', () => {
  const editor = createSecureCustomFieldEditor({ normalizeTypes: false });
  const original = { name: '', value: '', protected: true, future: { empty: null } };
  const emptySource = editor.draft(original);
  const source = editor.draft({ name: 'Same', value: 'old', protected: false });
  source.value = 'new';
  expect(editor.serialize([source, emptySource, { name: 'New', value: 'x', protected: true }])).toEqual([
    { name: 'Same', value: 'new', protected: false }, original, { name: 'New', value: 'x', protected: true }
  ]);
});

it('applies the password form protection control without wallet type normalization', () => {
  const editor = createSecureCustomFieldEditor({ normalizeTypes: false });
  const draft = editor.draft({ name: 'Secret', value: 'x', protected: true });
  draft.protected = false;
  expect(editor.serialize([draft])).toEqual([{ name: 'Secret', value: 'x', protected: false }]);
});

it('edits one value without normalizing legacy sibling fields or removing unnamed source rows', () => {
  const source = [{ name: 'Secret', value: 'old', protected: true, future: { empty: null, exact: '9007199254740993' } },
    { name: '', value: 'source data', protected: false }, { name: 'Flag', value: 'true', protected: false }] satisfies (SecureCustomField & Record<string, unknown>)[];
  const editor = createSecureCustomFieldEditor(), drafts = source.map(editor.draft);
  drafts[0].value = 'new';
  expect(editor.serialize(drafts)).toEqual([{ ...source[0], value: 'new' }, ...source.slice(1)]);
  expect(source[0].value).toBe('old');
});

it('keeps duplicate occurrences and their unknown properties attached through rename and reorder', () => {
  const source = [{ name: 'Same', value: 'one', protected: false, future: 'first' }, { name: 'Same', value: 'two', protected: true, future: 'second' }];
  const editor = createSecureCustomFieldEditor(), drafts = source.map(editor.draft);
  drafts[1].name = 'Renamed';
  expect(editor.serialize([drafts[1], drafts[0]])).toEqual([{ ...source[1], name: 'Renamed' }, source[0]]);
});

it('preserves absent fieldType until it is explicitly changed', () => {
  const editor = createSecureCustomFieldEditor(), original = { name: 'Secret', value: 'x', protected: true };
  const draft = editor.draft(original);
  expect(editor.serialize([draft])).toEqual([original]);
  draft.fieldType = 'TEXT';
  expect(editor.serialize([draft])).toEqual([{ ...original, fieldType: 'TEXT', protected: false }]);
});

it('supports explicit deletion while retaining otherwise identical neighbors', () => {
  const editor = createSecureCustomFieldEditor();
  const first = editor.draft({ name: 'Same', value: 'same', protected: false });
  const second = editor.draft({ name: 'Same', value: 'same', protected: true });
  expect(editor.serialize([second])).toEqual([{ name: 'Same', value: 'same', protected: true }]);
  expect(editor.serialize([first])).toEqual([{ name: 'Same', value: 'same', protected: false }]);
});

it('rejects silently dropping a newly entered value or erasing an existing name', () => {
  const editor = createSecureCustomFieldEditor();
  expect(editor.serialize([{ name: '', value: '', protected: false }])).toEqual([]);
  expect(() => editor.serialize([{ name: '', value: 'do not lose', protected: false }])).toThrow('请输入自定义字段名称');
  expect(editor.serialize([{ name: '', value: 'do not lose', protected: false }], { validate: false })).toEqual([
    { name: '', value: 'do not lose', protected: false, fieldType: 'TEXT' }
  ]);
  const draft = editor.draft({ name: 'Named', value: 'old', protected: false });
  draft.name = '';
  expect(() => editor.serialize([draft])).toThrow('请输入自定义字段名称');
});
