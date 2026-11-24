# Private inbox deploy configs
Arthur's and Michael's private inboxes run the same code as `main` with a different wrangler config.
Deploy: copy `wrangler.<who>.jsonc` over `wrangler.jsonc` in a scratch copy of main, then `npm run deploy` there (never commit the swap).
Secrets (POLICY_AUD, TEAM_DOMAIN) live on the Workers already. Sasha's inbox was retired 2026-11-22.
