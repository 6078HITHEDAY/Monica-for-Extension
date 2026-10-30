/** Persist only a public operation identity. Never store an executable request. */
export interface PendingOperation {id:string;vault:string;database:string;operation:string;created:number}
const prefix='monica.cli.operation.';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class CliRecovery {
  constructor(private readonly storage:Storage=localStorage) {}
  list():PendingOperation[] {
    const items:PendingOperation[]=[];
    for(let i=0;i<this.storage.length;i++) {
      const key=this.storage.key(i);if(!key?.startsWith(prefix))continue;
      try {const p=JSON.parse(this.storage.getItem(key)||'null');
        if(p && uuid.test(p.id) && key===prefix+p.id && typeof p.vault==='string' && typeof p.database==='string' && /^[a-z_]{1,40}$/.test(p.operation) && Number.isSafeInteger(p.created)) items.push({id:p.id,vault:p.vault,database:p.database,operation:p.operation,created:p.created});
      }catch{/* Corrupt records are not executable. */}
    }
    return items.sort((a,b)=>a.created-b.created);
  }
  begin(vault:string,database:string,operation:string):PendingOperation {
    if(this.list().length>=64) throw Error('Recovery capacity reached');
    const item={id:crypto.randomUUID(),vault,database,operation,created:Date.now()};
    this.storage.setItem(prefix+item.id,JSON.stringify(item));return item;
  }
  forget(id:string) {if(!uuid.test(id))throw Error('Invalid identity');this.storage.removeItem(prefix+id);}
}
