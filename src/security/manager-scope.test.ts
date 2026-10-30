import {expect,it} from 'vitest';
import {SecureVaultService} from './secure-vault-service';
import {MemoryVaultSessionStore} from './vault-session';
import {MemoryVaultStorage} from './vault-storage';
it('persists separate page scopes encrypted across restart without losing concurrent page preferences or queuing provider sync',async()=>{
  const storage=new MemoryVaultStorage(),service=new SecureVaultService(storage,new MemoryVaultSessionStore());
  await service.setup('Synthetic folder preferences password');
  await Promise.all([
    service.setHomePreferences({managerScopes:{steam:{source:'db-one',folder:'private-category-sentinel'}}}),
    service.setHomePreferences({managerScopes:{passkeys:{source:'local',folder:'all'}}})
  ]);
  expect(JSON.stringify(await storage.read())).not.toContain('private-category-sentinel');
  const resumed=new SecureVaultService(storage,new MemoryVaultSessionStore());
  await resumed.unlock('Synthetic folder preferences password');
  expect((await resumed.getHomePreferences()).managerScopes).toEqual({steam:{source:'db-one',folder:'private-category-sentinel'},passkeys:{source:'local',folder:'all'}});
  expect((await resumed.readState(false)).mutationQueue).toEqual([]);
});
