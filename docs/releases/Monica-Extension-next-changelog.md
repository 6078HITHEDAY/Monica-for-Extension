# Monica Extension 下一版 / Next release

> 未发布 / Unreleased；版本号待定 / Version pending

## 中文

- 整理后台同步、附件传输与 Bitwarden Send 的模块职责，将任务状态、上传会话和清理逻辑集中管理，便于后续维护。
- 统一外部请求与内部附件写入的授权和互斥执行，补齐命令覆盖审计及取消、重试和会话失效回归。保持现有加密格式、登录和数据库后端选择。

## English

- Refactored background synchronization, attachment transfer and Bitwarden Send into modules that own their task state, upload sessions and cleanup.
- Unified authorization and exclusive execution for external requests and internal attachment writes; strengthened command coverage auditing and cancellation, retry and stale-session regressions. Existing encryption formats, login behavior and database backend selection remain unchanged.
