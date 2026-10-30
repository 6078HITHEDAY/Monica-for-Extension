import {readFile, writeFile} from 'node:fs/promises';
const key = '项目移除期间本地内容已修改，移除已撤销；本地与远端版本均已保留，请核对后选择。';
const translations = {
  en: 'Local content changed during removal, so the removal was cancelled. Both local and remote versions are preserved. Review them and choose a version.',
  ja: '削除中にローカルの内容が変更されたため、削除を取り消しました。ローカルとリモートの両方の版を保持しています。確認して選択してください。',
  ko: '삭제 도중 로컬 내용이 변경되어 삭제를 취소했습니다. 로컬 버전과 원격 버전을 모두 보관했습니다. 확인 후 선택하세요.',
  de: 'Der lokale Inhalt wurde während des Entfernens geändert. Der Vorgang wurde abgebrochen. Die lokale und die entfernte Version bleiben erhalten. Prüfen Sie beide und wählen Sie eine Version.',
  es: 'El contenido local cambió durante la eliminación, por lo que se canceló. Se conservan las versiones local y remota. Revísalas y elige una versión.',
  ru: 'Во время удаления локальные данные изменились, поэтому удаление отменено. Локальная и удалённая версии сохранены. Проверьте их и выберите нужную.',
  vi: 'Nội dung cục bộ đã thay đổi trong khi xóa nên thao tác xóa đã bị hủy. Cả phiên bản cục bộ và từ xa đều được giữ lại. Hãy kiểm tra và chọn một phiên bản.'
};
for(const [locale, value] of Object.entries(translations)) {
  const file = new URL(locale === 'en' ? '../src/i18n/ui-en.json' : `../public/locales/ui-${locale}.json`, import.meta.url);
  const catalog=JSON.parse(await readFile(file,'utf8')); catalog[key]=value;
  await writeFile(file,JSON.stringify(catalog,null,2)+'\n');
}
