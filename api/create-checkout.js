// Vercel Serverless Function - Creates Shopify Draft Order and returns invoice (checkout) URL
//
// Supports BOTH:
//  1) Legacy "calculator quote" (custom line item) via totalPrice
//  2) Real products checkout via items: [{ handle, quantity }]
//
// Optional: SMTP internal notifications (shipping + selected account manager + info)

import nodemailer from "nodemailer";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

// In-memory cache (can persist across warm invocations on Vercel)
const _cache = globalThis.__variantCache || (globalThis.__variantCache = new Map());

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function uniqEmails(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const e = String(raw || "").trim().toLowerCase();
    if (!e || !e.includes("@")) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

async function shopifyGraphql(shopName, accessToken, query, variables) {
  const url = `https://${shopName}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.errors ? safeJson(json.errors) : safeJson(json);
    throw new Error(`Shopify GraphQL error (${resp.status}): ${msg}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${safeJson(json.errors)}`);
  }
  return json.data;
}

async function resolveVariantByHandle(shopName, accessToken, handle) {
  const key = String(handle || "").trim();
  if (!key) throw new Error("Missing product handle");

  if (_cache.has(key)) return _cache.get(key);

  const query = `
    query ProductByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        title
        variants(first: 1) {
          edges {
            node {
              legacyResourceId
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(shopName, accessToken, query, { handle: key });
  const product = data?.productByHandle;
  const legacyResourceId = product?.variants?.edges?.[0]?.node?.legacyResourceId;

  if (!product || !legacyResourceId) {
    throw new Error(`Product not found or has no variants for handle: ${key}`);
  }

  const resolved = {
    handle: key,
    title: product.title || key,
    variantId: Number(legacyResourceId),
  };

  _cache.set(key, resolved);
  return resolved;
}

function buildLegacyLineItem(calculatorType, calculatorData, totalPrice) {
  const price = Number(totalPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("totalPrice must be a valid number > 0 for legacy quote checkouts");
  }

  const properties = [];

  properties.push({ name: "Calculator Type", value: calculatorType || "Calculator" });

  if (calculatorData && typeof calculatorData === "object") {
    for (const [k, v] of Object.entries(calculatorData)) {
      if (k === "timestamp" || k === "calculator") continue;
      const label = String(k)
        .replace(/([A-Z])/g, " $1")
        .replace(/_/g, " ")
        .trim()
        .split(" ")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
      properties.push({ name: label, value: String(v) });
    }
  }

  properties.push({
    name: "Quote Date",
    value: new Date().toISOString(),
  });

  return {
    title: `${calculatorType || "Calculator"} Quote Order`,
    price: price.toFixed(2),
    quantity: 1,
    requires_shipping: false,
    taxable: true,
    properties,
  };
}

async function sendInternalEmail({
  smtp,
  to,
  subject,
  html,
  text,
}) {
  if (!smtp?.host || !smtp?.user || !smtp?.pass) return { skipped: true };

  const port = Number(smtp.port || 587);
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port,
    secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  await transporter.sendMail({
    from: smtp.from || smtp.user,
    to,
    subject,
    text,
    html,
  });

  return { sent: true };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      calculatorType,
      calculatorData,
      totalPrice,
      currency,
      customerEmail,
      customerName,
      accountManagerName,
      accountManagerEmail,
      notifyEmails,
      items,
      shippingValidityHours,
    } = body;

    const SHOP_NAME = process.env.SHOPIFY_SHOP_NAME;
    const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!SHOP_NAME || !ACCESS_TOKEN) {
      return res.status(500).json({ error: "Server configuration error (missing SHOPIFY_SHOP_NAME or SHOPIFY_ACCESS_TOKEN)" });
    }

    const useRealItems = Array.isArray(items) && items.length > 0;

    const draft_order = {
      currency: currency || "USD",
      tags: `calculator-order,calculator-${calculatorType || "unknown"}`,
      use_customer_default_address: true,
      note_attributes: [],
    };

    if (customerEmail) draft_order.email = customerEmail;

    if (customerName) {
      draft_order.note_attributes.push({ name: "Customer Name", value: String(customerName) });
    }
    if (accountManagerName) {
      draft_order.note_attributes.push({ name: "Account Manager", value: String(accountManagerName) });
    }
    if (accountManagerEmail) {
      draft_order.note_attributes.push({ name: "Account Manager Email", value: String(accountManagerEmail) });
    }
    if (shippingValidityHours) {
      draft_order.note_attributes.push({ name: "Shipping Quote Validity", value: `${shippingValidityHours} hours` });
    }

    // Always attach calculator data (keeps your internal visibility)
    draft_order.note = `Calculator: ${calculatorType || "unknown"}\n\n${safeJson(calculatorData)}`;

    // Build line items
    if (useRealItems) {
      const lineItems = [];
      for (const raw of items) {
        const handle = String(raw?.handle || "").trim();
        const qty = Number(raw?.quantity || 0);

        if (!handle) continue;
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const resolved = await resolveVariantByHandle(SHOP_NAME, ACCESS_TOKEN, handle);
        lineItems.push({ variant_id: resolved.variantId, quantity: Math.round(qty) });
      }

      if (!lineItems.length) {
        return res.status(400).json({ error: "No valid line items provided" });
      }

      draft_order.line_items = lineItems;
      draft_order.tags += ",real-products";
    } else {
      // Legacy quote order
      draft_order.line_items = [
        buildLegacyLineItem(calculatorType, calculatorData, totalPrice),
      ];
      draft_order.tags += ",legacy-quote";
    }

    const draftOrderPayload = { draft_order };

    const resp = await fetch(
      `https://${SHOP_NAME}.myshopify.com/admin/api/${API_VERSION}/draft_orders.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
        body: JSON.stringify(draftOrderPayload),
      }
    );

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(resp.status).json({
        error: "Shopify draft order failed",
        details: json?.errors || json,
      });
    }

    const draftOrder = json?.draft_order;
    const checkoutUrl = draftOrder?.invoice_url;

    // Internal notifications (optional)
    const smtp = {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
    };

    const recipients = uniqEmails([
      ...(Array.isArray(notifyEmails) ? notifyEmails : []),
      accountManagerEmail,
    ]);

    if (recipients.length) {
      // Resolve titles for email if real items
      let itemLinesHtml = "";
      if (useRealItems) {
        const rows = [];
        for (const raw of items) {
          const handle = String(raw?.handle || "").trim();
          const qty = Number(raw?.quantity || 0);
          if (!handle || !Number.isFinite(qty) || qty <= 0) continue;

          const resolved = await resolveVariantByHandle(SHOP_NAME, ACCESS_TOKEN, handle);
          rows.push(`<li><strong>${resolved.title}</strong> <span style="color:#6b7280;">(${resolved.handle})</span> — Qty: ${Math.round(qty)}</li>`);
        }
        itemLinesHtml = rows.length ? `<ul>${rows.join("")}</ul>` : "<em>No items list</em>";
      } else {
        itemLinesHtml = "<em>Legacy quote (single custom line item)</em>";
      }

      const subject = `New Draft Order (${calculatorType || "calculator"}) — ${draftOrder?.name || ""}`.trim();
      const shippingNote = shippingValidityHours
        ? `Shipping prices valid for <strong>${shippingValidityHours} hours</strong>.`
        : "Shipping prices valid for <strong>72 hours</strong>.";

      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif; line-height:1.5; color:#111827;">
          <h2 style="margin:0 0 8px;">New Calculator Draft Order</h2>
          <p style="margin:0 0 10px;">${shippingNote}</p>
          <p style="margin:0 0 4px;"><strong>Draft Order:</strong> ${draftOrder?.name || ""}</p>
          <p style="margin:0 0 4px;"><strong>Checkout Link:</strong> <a href="${checkoutUrl}">${checkoutUrl}</a></p>
          <p style="margin:0 0 4px;"><strong>Customer:</strong> ${customerName || "-"} (${customerEmail || "-"})</p>
          <p style="margin:0 0 12px;"><strong>Account Manager:</strong> ${accountManagerName || "-"} (${accountManagerEmail || "-"})</p>
          <h3 style="margin:14px 0 6px;">Items</h3>
          ${itemLinesHtml}
          <h3 style="margin:14px 0 6px;">Calculator Data</h3>
          <pre style="background:#f3f4f6; padding:12px; border-radius:10px; overflow:auto;">${safeJson(calculatorData)}</pre>
        </div>
      `;

      const text = `New Calculator Draft Order\n\nDraft Order: ${draftOrder?.name || ""}\nCheckout: ${checkoutUrl}\nCustomer: ${customerName || "-"} (${customerEmail || "-"})\nAccount Manager: ${accountManagerName || "-"} (${accountManagerEmail || "-"})\n\nItems:\n${useRealItems ? items.map(i => `- ${i.handle} x${i.quantity}`).join("\n") : "Legacy quote (single line item)"}\n\nCalculator Data:\n${safeJson(calculatorData)}`;

      // Fire-and-forget is risky in serverless; we await but ignore errors gracefully
      try {
        await sendInternalEmail({ smtp, to: recipients.join(","), subject, html, text });
      } catch (e) {
        console.error("SMTP email failed:", e?.message || e);
      }
    }

    return res.status(200).json({
      success: true,
      checkoutUrl,
      draftOrderId: draftOrder?.id,
      orderName: draftOrder?.name,
      totalPrice: draftOrder?.total_price,
    });
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: "Internal server error", message: error?.message || String(error) });
  }
}
