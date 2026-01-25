# Calculator Checkout API

This Vercel serverless function creates Shopify Draft Orders for calculator quotes.

## Setup

1. Deploy to Vercel
2. Add environment variables in Vercel dashboard:
   - `SHOPIFY_SHOP_NAME`: Your Shopify store name (e.g., `5e4e86` from `5e4e86.myshopify.com`)
   - `SHOPIFY_CLIENT_ID`: From Shopify app
   - `SHOPIFY_CLIENT_SECRET`: From Shopify app
   - `SHOPIFY_ACCESS_TOKEN`: From Shopify app

## API Endpoint

**POST** `/api/create-checkout`

### Request Body:
```json
{
  "calculatorType": "Resin Bound Calculator",
  "calculatorData": {
    "area": "500 ft²",
    "totalCost": "1250.00"
  },
  "totalPrice": "1250.00",
  "currency": "USD",
  "customerEmail": "customer@example.com",
  "customerName": "John Doe"
}
```

### Response:
```json
{
  "success": true,
  "checkoutUrl": "https://store.myshopify.com/...",
  "draftOrderId": 123456789,
  "orderName": "#D1234",
  "totalPrice": "1250.00"
}
```
