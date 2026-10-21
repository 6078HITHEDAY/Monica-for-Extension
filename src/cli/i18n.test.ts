import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import globalEnglish from '../i18n/ui-en.json';
import { updateUiLocale } from '../i18n/runtime';
import { cliEnglish, tr } from './i18n';

afterEach(()=>updateUiLocale('zh-CN'));

describe('CLI scoped localization',()=>{
  it('covers literal labels and dynamic error, operation and heading maps',()=>{
    const view=readFileSync('src/components/CliManagement.vue','utf8');
    expect(view).toContain("import { tr as cliTr } from '../cli/i18n'");
    expect(view).not.toMatch(/\btr\(/);
    const messages=new Set<string>();
    const script=view.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
    const source=ts.createSourceFile('cli.ts',script,ts.ScriptTarget.Latest,true);
    const visit=(node:ts.Node)=>{
      if(ts.isStringLiteral(node) && /\p{Script=Han}/u.test(node.text))messages.add(node.text);
      ts.forEachChild(node,visit);
    };
    visit(source);
    for(const match of view.slice(view.indexOf('<template>')).matchAll(/\bcliTr\('([^']+)'\)/g))messages.add(match[1]);
    expect(messages.size).toBeGreaterThan(100);
    const dictionary:Record<string,string>={...globalEnglish,...cliEnglish};
    expect([...messages].filter(source=>!Object.prototype.hasOwnProperty.call(dictionary,source))).toEqual([]);
    for(const message of messages){expect(dictionary[message]).toBeTruthy();expect(dictionary[message]).not.toMatch(/\p{Script=Han}/u);}
  });
  it('preserves Chinese and falls back offline for other selected languages',()=>{
    const source='保存结果需要核对';
    updateUiLocale('zh-CN');expect(tr(source)).toBe(source);
    for(const language of ['en','de','ja','es','ko','ru','vi'] as const){
      updateUiLocale(language);expect(tr(source)).toBe('Save result needs verification');
    }
  });
});
