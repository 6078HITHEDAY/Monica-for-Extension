import { describe, expect, it } from 'vitest';
import {createLoginItem, type ProviderAccount} from '../core/model';
import {managerFolders,matchesManagerFolder,readManagerScope} from './folder-scope';
import {normalizeHomePreferences} from '../core/home-preferences';

const providers: ProviderAccount[] = ['one','two'].map(id=>({id,name:id,kind:'keepass',enabled:true,isDefaultSaveTarget:false,config:{}}));
describe('manager folder scope',()=>{
  it('finds native folders without Android categories and distinguishes equal names and IDs across sources',()=>{
    const rows=providers.map(source=>({...createLoginItem({title:source.name}),keepassGroupPath:'Games/Steam',keepassGroupUuid:'same-id',providerRefs:[{providerId:source.id}]}));
    const folders=managerFolders(rows,providers,'all');
    expect(folders).toHaveLength(2);expect(new Set(folders.map(row=>row.key)).size).toBe(2);
    expect(managerFolders(rows,providers,'one')).toHaveLength(1);
    expect(rows.filter(row=>matchesManagerFolder(row,folders[0].key,'all',providers))).toHaveLength(1);
    expect(rows.filter(row=>matchesManagerFolder(row,'uncategorized','all',providers))).toHaveLength(0);
  });
  it('retains each page selection independently without labels or item data',()=>{
    const scopes=normalizeHomePreferences({managerScopes:{steam:{source:'one',folder:'native-folder'},passkeys:{source:'local',folder:'all'}}}).managerScopes!;
    expect(readManagerScope(scopes,'steam')).toEqual({source:'one',folder:'native-folder'});
    expect(readManagerScope(scopes,'passkeys')).toEqual({source:'local',folder:'all'});
    expect(readManagerScope(scopes,'vault')).toEqual({source:'all',folder:'all'});
  });
});
