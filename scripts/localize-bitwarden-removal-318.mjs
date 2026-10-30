import { readFile, writeFile } from 'node:fs/promises';
const keys = [
  '原密码中的 Passkey 会先保留为同一账号下的独立项目，再移除密码。',
  '正在保留 Passkey',
  '已创建或尚未确认的独立 Passkey 副本会保留在 Bitwarden，请同步后检查。',
  '请登录原 Bitwarden 账号后继续。',
  '已核对 {0} / {1} 个独立 Passkey 副本',
  '密码库解锁会话已变化，请重新打开项目。',
  '恢复期间密码源已变化，请重新打开密码源。',
  '请先完成未处理的密码移除，再同步此密码源。',
  '此密码源正在处理其他操作，请稍后重试。',
  '密码源恢复必须由当前同步操作执行。'
];
const translations = {
  ja: [
    '元のパスワードに含まれるパスキーを同じアカウントの独立した項目として保存してから、パスワードを削除します。',
    'パスキーを保存しています',
    '作成済み、または結果を確認できていない独立したパスキーのコピーは Bitwarden に残ります。同期後に確認してください。',
    '元の Bitwarden アカウントにログインして続行してください。',
    '独立したパスキーのコピー {0} / {1} 件を確認済み',
    '保管庫のロック解除セッションが変わりました。項目を開き直してください。',
    '復元中にパスワードソースが変わりました。ソースを開き直してください。',
    '未完了のパスワード削除を完了してから、このソースを同期してください。',
    'このパスワードソースは別の操作を処理中です。しばらくしてから再試行してください。',
    'ソースの復元は現在の同期操作内で実行する必要があります。'
  ],
  ko: [
    '원래 비밀번호의 패스키를 같은 계정의 독립 항목으로 먼저 저장한 다음 비밀번호를 제거합니다.',
    '패스키 보존 중',
    '이미 생성했거나 결과를 확인하지 못한 독립 패스키 사본은 Bitwarden에 남습니다. 동기화 후 확인하세요.',
    '계속하려면 원래 Bitwarden 계정에 로그인하세요.',
    '독립 패스키 사본 {0} / {1}개 확인됨',
    '보관함 잠금 해제 세션이 변경되었습니다. 항목을 다시 여세요.',
    '복구 중 비밀번호 소스가 변경되었습니다. 소스를 다시 여세요.',
    '처리 중인 비밀번호 제거를 완료한 후 이 소스를 동기화하세요.',
    '이 비밀번호 소스에서 다른 작업을 처리 중입니다. 잠시 후 다시 시도하세요.',
    '소스 복구는 현재 동기화 작업 내에서 실행해야 합니다.'
  ],
  de: [
    'Passkeys des ursprünglichen Passworts werden zuerst als separate Einträge im selben Konto gespeichert. Danach wird das Passwort entfernt.',
    'Passkeys werden gesichert',
    'Bereits erstellte oder noch nicht bestätigte separate Passkey-Kopien bleiben in Bitwarden erhalten. Bitte nach der Synchronisierung prüfen.',
    'Melden Sie sich zum Fortfahren beim ursprünglichen Bitwarden-Konto an.',
    '{0} / {1} separate Passkey-Kopien geprüft',
    'Die Entsperrsitzung des Tresors hat sich geändert. Öffnen Sie das Projekt erneut.',
    'Die Passwortquelle hat sich während der Wiederherstellung geändert. Öffnen Sie die Quelle erneut.',
    'Schließen Sie zuerst die ausstehende Passwortentfernung ab, bevor Sie diese Quelle synchronisieren.',
    'Diese Passwortquelle verarbeitet einen anderen Vorgang. Versuchen Sie es gleich erneut.',
    'Die Wiederherstellung der Quelle muss innerhalb der aktuellen Synchronisierung erfolgen.'
  ],
  es: [
    'Las passkeys de la contraseña original se guardarán primero como elementos independientes en la misma cuenta. Después se eliminará la contraseña.',
    'Conservando passkeys',
    'Las copias independientes de passkeys ya creadas o pendientes de confirmación permanecerán en Bitwarden. Sincroniza y revísalas.',
    'Inicia sesión en la cuenta original de Bitwarden para continuar.',
    '{0} / {1} copias independientes de passkeys verificadas',
    'La sesión de desbloqueo de la bóveda ha cambiado. Vuelve a abrir el proyecto.',
    'La fuente de contraseñas cambió durante la recuperación. Vuelve a abrirla.',
    'Completa la eliminación de contraseñas pendiente antes de sincronizar esta fuente.',
    'Esta fuente de contraseñas está procesando otra operación. Inténtalo de nuevo en unos momentos.',
    'La recuperación de la fuente debe ejecutarse dentro de la sincronización actual.'
  ],
  ru: [
    'Ключи доступа исходного пароля сначала будут сохранены как отдельные записи в той же учётной записи. Затем пароль будет удалён.',
    'Сохранение ключей доступа',
    'Созданные или ещё не подтверждённые отдельные копии ключей доступа останутся в Bitwarden. Проверьте их после синхронизации.',
    'Войдите в исходную учётную запись Bitwarden, чтобы продолжить.',
    'Проверено отдельных копий ключей доступа: {0} / {1}',
    'Сеанс разблокировки хранилища изменился. Откройте проект заново.',
    'Источник паролей изменился во время восстановления. Откройте источник заново.',
    'Завершите ожидающее удаление паролей перед синхронизацией этого источника.',
    'Этот источник паролей выполняет другую операцию. Повторите попытку чуть позже.',
    'Восстановление источника должно выполняться в рамках текущей синхронизации.'
  ],
  vi: [
    'Passkey trong mật khẩu gốc sẽ được lưu thành các mục riêng trong cùng tài khoản trước khi xóa mật khẩu.',
    'Đang giữ lại Passkey',
    'Các bản sao Passkey riêng đã tạo hoặc chưa xác nhận sẽ được giữ trong Bitwarden. Hãy đồng bộ rồi kiểm tra.',
    'Đăng nhập vào tài khoản Bitwarden ban đầu để tiếp tục.',
    'Đã xác minh {0} / {1} bản sao Passkey riêng',
    'Phiên mở khóa kho đã thay đổi. Hãy mở lại dự án.',
    'Nguồn mật khẩu đã thay đổi trong khi khôi phục. Hãy mở lại nguồn.',
    'Hoàn tất thao tác xóa mật khẩu đang chờ trước khi đồng bộ nguồn này.',
    'Nguồn mật khẩu này đang xử lý thao tác khác. Hãy thử lại sau ít phút.',
    'Phải khôi phục nguồn trong thao tác đồng bộ hiện tại.'
  ]
};
for (const [locale, values] of Object.entries(translations)) {
  if (values.length !== keys.length) throw new Error(`Incomplete ${locale} translation`);
  const path = new URL(`../public/locales/ui-${locale}.json`, import.meta.url);
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  keys.forEach((key, index) => { catalog[key] = values[index]; });
  await writeFile(path, JSON.stringify(catalog, null, 2) + '\n');
}
