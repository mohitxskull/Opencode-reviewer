.PHONY: check lint typecheck test

check:
	bun run lint && bun run typecheck && bun test

lint:
	bun run lint

typecheck:
	bun run typecheck

test:
	bun test
