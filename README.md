# Calculator Checkout API (Draft Orders)

This Vercel serverless function creates Shopify Draft Orders and returns the Draft Order **invoice_url**
(used as a checkout link).

It supports two modes:

1) **Legacy quote mode** (keeps existing calculators working):
- Send `totalPrice` and the API creates a single custom line item.

2) **Real-products mode** (recommended for inventory + quick ordering):
- Send `items: [{ handle, quantity }]` and the API resolves **handles → variant_ids**
  then creates a draft order with real Shopify products (inventory-aware).

---

## Environment Variables (Vercel)

Required:
- `SHOPIFY_SHOP_NAME` → e.g. if your admin domain is `resinrockllc.myshopify.com`, use `resinrockllc`
- `SHOPIFY_ACCESS_TOKEN` → Admin API access token

Optional:
- `SHOPIFY_API_VERSION` → defaults to `2026-01`

SMTP (optional, for internal notifications):
- `SMTP_HOST`
- `SMTP_PORT` (587 or 465)
- `SMTP_USER` (e.g., info@resinrockllc.com)
- `SMTP_PASS`
- `SMTP_FROM` (optional; defaults to SMTP_USER)

---

## Endpoint

**POST** `/api/create-checkout`

---

## Request Body (Legacy Quote Mode)

```json
{
  "calculatorType": "main-calculator",
  "calculatorData": { "area": 500, "totalCost": 1250.00 },
  "totalPrice": 1250.00,
  "currency": "USD",
  "customerEmail": "customer@example.com",
  "customerName": "John Doe"
}
```

---

## Request Body (Real Products Mode)

```json
{
  "calculatorType": "main-calculator",
  "calculatorData": { "area": 500, "binderKits": 4, "unit": "ft²" },
  "currency": "USD",
  "customerEmail": "customer@example.com",
  "customerName": "John Doe",
  "accountManagerName": "James Adkins",
  "accountManagerEmail": "james@resinrockllc.com",
  "notifyEmails": ["shipping@resinrockllc.com", "info@resinrockllc.com"],
  "shippingValidityHours": 72,
  "items": [
    { "handle": "resin-rock-primer", "quantity": 3 },
    { "handle": "mesh", "quantity": 2 },
    { "handle": "black-uv-color-kit", "quantity": 4 }
  ]
}
```

---

## Response

```json
{
  "success": true,
  "checkoutUrl": "https://store.myshopify.com/...",
  "draftOrderId": 123456789,
  "orderName": "#D1234",
  "totalPrice": "1250.00"
}
```

