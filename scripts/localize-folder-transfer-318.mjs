import {readFile,writeFile} from 'node:fs/promises';
const translations={
en:['All folders','Skip unavailable entries and continue'],
de:['Alle Ordner','Nicht verfügbare Einträge überspringen und fortfahren'],
es:['Todas las carpetas','Omitir entradas no disponibles y continuar'],
ja:['すべてのフォルダー','利用できない項目をスキップして続行'],
ko:['모든 폴더','사용할 수 없는 항목을 건너뛰고 계속'],
ru:['Все папки','Пропустить недоступные записи и продолжить'],
vi:['Tất cả thư mục','Bỏ qua mục không khả dụng và tiếp tục']};
for(const [locale,values] of Object.entries(translations)){
 const file=locale==='en'?'src/i18n/ui-en.json':`public/locales/ui-${locale}.json`;
 const data=JSON.parse(await readFile(file,'utf8'));
 ['全部文件夹','跳过受限项并继续'].forEach((key,i)=>{data[key]=values[i];});
 await writeFile(file,JSON.stringify(data,null,2)+'\n');
}
