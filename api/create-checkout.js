// Vercel Serverless Function - Creates Draft Order and Returns Checkout URL

export default async function handler(req, res) {
  // CORS Headers - Allow requests from your Shopify store
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      calculatorType,
      calculatorData,
      totalPrice,
      currency,
      customerEmail,
      customerName 
    } = req.body;

    // Validate required fields
    if (!calculatorData || !totalPrice) {
      return res.status(400).json({ 
        error: 'Missing required fields: calculatorData and totalPrice are required' 
      });
    }

    // Get credentials from environment variables
    const SHOP_NAME = process.env.SHOPIFY_SHOP_NAME;
    const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
    const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
    const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
    // Use Client Credentials for API access
const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    if (!SHOP_NAME || !ACCESS_TOKEN) {
      console.error('Missing environment variables');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Format line item properties from calculator data
    const lineItemProperties = [];
    
    // Add calculator type
    lineItemProperties.push({
      name: 'Calculator Type',
      value: calculatorType || 'Calculator Order'
    });

    // Add all calculator data as properties
    if (typeof calculatorData === 'object') {
      for (const [key, value] of Object.entries(calculatorData)) {
        if (key !== 'timestamp' && key !== 'calculator') {
          // Format key nicely
          const formattedKey = key
            .replace(/([A-Z])/g, ' $1')
            .replace(/_/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          lineItemProperties.push({
            name: formattedKey,
            value: String(value)
          });
        }
      }
    }

    // Add timestamp
    lineItemProperties.push({
      name: 'Quote Date',
      value: new Date().toLocaleString('en-US', { 
        timeZone: 'America/New_York',
        dateStyle: 'full',
        timeStyle: 'short'
      })
    });

    // Convert price to cents (Shopify uses cents)
    const priceInCents = Math.round(parseFloat(totalPrice) * 100);
    const priceFormatted = (priceInCents / 100).toFixed(2);

    // Create Draft Order using Shopify Admin API
    const draftOrderData = {
      draft_order: {
        line_items: [
          {
            title: `${calculatorType || 'Calculator'} Quote Order`,
            price: priceFormatted,
            quantity: 1,
            requires_shipping: false,
            taxable: true,
            properties: lineItemProperties
          }
        ],
        note: `Calculator Order - ${calculatorType}\n\nCalculation Details:\n${JSON.stringify(calculatorData, null, 2)}`,
        tags: 'calculator-order, quote',
        use_customer_default_address: true
      }
    };

    // Add customer info if provided
    if (customerEmail) {
      draftOrderData.draft_order.email = customerEmail;
    }
    if (customerName) {
      draftOrderData.draft_order.note_attributes = [
        { name: 'Customer Name', value: customerName }
      ];
    }

    // Make API request to Shopify
    const shopifyResponse = await fetch(
      `https://${SHOP_NAME}.myshopify.com/admin/api/2024-01/draft_orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': ACCESS_TOKEN
        },
        body: JSON.stringify(draftOrderData)
      }
    );

    const responseData = await shopifyResponse.json();

    if (!shopifyResponse.ok) {
      console.error('Shopify API Error:', responseData);
      return res.status(shopifyResponse.status).json({ 
        error: 'Failed to create order',
        details: responseData.errors || responseData
      });
    }

    // Get the checkout URL from draft order
    const draftOrder = responseData.draft_order;
    const checkoutUrl = draftOrder.invoice_url;

    // Return success with checkout URL
    return res.status(200).json({
      success: true,
      checkoutUrl: checkoutUrl,
      draftOrderId: draftOrder.id,
      orderName: draftOrder.name,
      totalPrice: draftOrder.total_price
    });

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
