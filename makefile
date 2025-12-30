apply:
	npx prisma generate
	npx prisma migrate deploy

generate:
	npx prisma generate

migrate:
	npx prisma migrate dev $(name)

migrate-up:
	npx prisma migrate deploy

migrate-down:
	npx prisma migrate reset

migrate-status:
	npx prisma migrate status

seed:
	npx prisma db seed

connect:
	docker exec -it aams-app-server bash

dev:
	npm run start:dev

log:
	docker logs -f aams-app-server -t --tail 10

pm2-log:
	pm2 logs --raw --name aams-app --lines 10

