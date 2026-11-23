.PHONY: check fmt lint typecheck test build

check:
	bun run format:check && bun run lint && bun run typecheck && bun test

fmt:
	bun run format

lint:
	bun run lint

typecheck:
	bun run typecheck

test:
	bun test

build:
	bun run build
