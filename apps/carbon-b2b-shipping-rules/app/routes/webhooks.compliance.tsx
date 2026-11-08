import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory privacy webhooks: customers/data_request, customers/redact,
 * shop/redact. This app stores no customer or order data — only the
 * merchant's Shopify session (access token) — so a customer request needs no
 * action, and shop/redact deletes the shop's sessions. authenticate.webhook
 * verifies the HMAC and answers 401 to anything not signed by Shopify.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} compliance webhook for ${shop}`);

  if (String(topic).toUpperCase().replace("/", "_") === "SHOP_REDACT") {
    await db.session.deleteMany({ where: { shop } });
  }
  return new Response();
};
