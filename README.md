# Glazia Quotation Backend

This service owns the quotation API surface:

- `/api/quotations`
- `/api/admin/quotations`
- `/api/user/quotation-data`

It does not expose login routes. It verifies the token created by the main
backend using the shared `JWT_SECRET` and `AUTH_COOKIE_NAME`.

## Run

```bash
npm install
cp .env.example prod.env
npm start
```

Use the same production `JWT_SECRET` as `backend-main/prod.env`.
