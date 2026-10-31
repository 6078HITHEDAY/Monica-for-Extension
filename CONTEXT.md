# Extension domain vocabulary

- **Password source / 密码源**: a local vault, Bitwarden account, KeePass file or MDBX database represented by a provider account. Its account binding identifies the underlying source; an account ID alone does not authorize reuse after reconnection.
- **Synchronization / 同步任务**: an operation that reconciles a source with Monica's encrypted working state. Manual synchronization includes writes made during an earlier running operation; background polling must not unlock the vault or renew its inactivity timeout.
- **Source activity / 密码源占用**: the current synchronization, Passkey refresh or project recovery that owns a source's cancellation signal. Only that owner may release its activity.
- **Attachment transfer / 附件传输**: a copy or explicitly confirmed move between source items. Reading, chunked upload, completion verification and source deletion form one workflow; write authorization and source ownership remain mandatory for internal calls.
- **Working copy / 工作副本**: an encrypted local representation whose durable receipts and source revision determine whether a retry may replay an earlier result. A successful in-memory mutation alone is not durable completion.
- **Passkey completion receipt / Passkey 完成回执**: a document-bound prepared or committed result. An interrupted registration can be reconciled against its stable item identity; an interrupted assertion must not be promoted using that registration rule. A locked vault can leave registration completion unknown.
- **Save candidate / 保存候选**: a short-lived submitted credential associated with a tab, frame and source origin. It can survive same-origin navigation for confirmation, unlike a Passkey request tied to an exact document.
- **Command table / 命令表**: the explicit typed mapping from an extension request discriminant to its domain handler. The complete aggregate table is called only after sender authorization and source write guards.
