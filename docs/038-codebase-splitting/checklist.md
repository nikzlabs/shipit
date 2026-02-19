# 038: Codebase Splitting — Checklist

## Split 1: types.ts → domain-grouped type files
- [ ] Create `src/server/types/` directory with domain files
- [ ] Re-export from `src/server/types.ts` to preserve imports

## Split 2: index.ts → handler modules
- [x] Create `src/server/validation.ts` (validateImages, resolveFileAttachments, formatFileContext, getErrorMessage)
- [x] Create `src/server/ws-handlers/types.ts` (HandlerContext interface)
- [x] Extract git-handlers.ts (get_git_log, rollback)
- [x] Extract file-handlers.ts (get_file_tree, get_file_content, list_docs, get_doc)
- [x] Extract terminal-handlers.ts (terminal_start, terminal_input, terminal_resize, clear_logs)
- [x] Extract settings-handlers.ts (set_api_key, clear_api_key, paste_auth_code, set_git_identity, get/save_global_settings, set_agent, list_agents, set_agent_env, list_features, get_usage_stats)
- [x] Extract misc-handlers.ts (preview_error, cancel_queued_message, interrupt_claude, full_reset)
- [x] Extract deploy-handlers.ts (list_deploy_targets, deploy_configure, initiate_deploy, get_deploy_history, cancel_deploy, get_project_settings, delete_deploy_config)
- [x] Extract github-handlers.ts (github_set_token, github_get_status, github_push, github_pull, github_set_remote, github_get_remotes, github_logout, github_search_repos, github_list_branches)
- [x] Extract pr-handlers.ts (github_create_pr, get_pr_status, merge_pr, generate_pr_description)
- [x] Extract session-handlers.ts (list_sessions, new_session, archive_session, rename_session, get_chat_history)
- [x] Extract worktree-handlers.ts (fork_session, list_worktrees, merge_session)
- [x] Extract template-handlers.ts (list_templates, apply_template, home_create_repo_with_template)
- [x] Extract thread-handlers.ts (list_threads, create_checkpoint, fork_thread, switch_thread)
- [x] Convert if-chain to switch dispatcher in index.ts
- [ ] Extract send-message.ts (send_message, home_send_with_repo, answer_question + runClaudeWithMessage)

## Split 3: App.tsx → custom hooks
- [ ] Create `src/client/utils/local-storage.ts`
- [ ] Create `src/client/hooks/useKeyboardShortcuts.ts`
- [ ] Create `src/client/hooks/useConnectionSync.ts`
- [ ] Create `src/client/hooks/useAutoFix.ts`
- [ ] Create `src/client/hooks/useMessageHandler.ts`
- [ ] Create `src/client/hooks/useAppCallbacks.ts`
