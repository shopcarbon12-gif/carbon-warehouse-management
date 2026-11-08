import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

/**
 * Settings for the B2B delivery rule.
 *
 * The rule itself is the Shopify Function in extensions/b2b-delivery-rules.
 * A delivery customization ties that function to the store; its settings live
 * in the customization's metafield $app:b2b-delivery-rules/function-configuration
 * (the function reads them at checkout). Nothing is stored in this app's own
 * database except the Shopify session.
 */

const NAMESPACE = "$app:b2b-delivery-rules";
const KEY = "function-configuration";
const TITLE = "B2B shipping rules";
/** extensions/b2b-delivery-rules/shopify.extension.toml handle (API 2026-07 creates by handle). */
const FUNCTION_HANDLE = "b2b-delivery-rules";

type Config = { enabled: boolean; keepTitles: string[]; renameTo: string };
const DEFAULTS: Config = { enabled: true, keepTitles: ["Standard"], renameTo: "" };

type AdminGraphql = Awaited<ReturnType<typeof authenticate.admin>>["admin"]["graphql"];

async function gql<T>(graphql: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!json.data) throw new Error(`Shopify error: ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

async function findState(graphql: AdminGraphql) {
  const data = await gql<{
    shopifyFunctions: { nodes: { id: string; apiType: string; appKey: string | null }[] };
    deliveryCustomizations: {
      nodes: { id: string; title: string; enabled: boolean; functionId: string; metafield: { value: string } | null }[];
    };
  }>(
    graphql,
    `#graphql
    query B2BShippingState {
      shopifyFunctions(first: 25, apiType: "delivery_customization") { nodes { id apiType appKey } }
      deliveryCustomizations(first: 25) {
        nodes { id title enabled functionId metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value } }
      }
    }`,
  );
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const fn = data.shopifyFunctions.nodes.find((f) => !apiKey || f.appKey === apiKey) ?? data.shopifyFunctions.nodes[0];
  const customization = fn ? data.deliveryCustomizations.nodes.find((c) => c.functionId === fn.id) : undefined;
  let config: Config = { ...DEFAULTS };
  if (customization?.metafield?.value) {
    try {
      const raw = JSON.parse(customization.metafield.value);
      config = {
        enabled: customization.enabled && raw.enabled !== false,
        keepTitles: Array.isArray(raw.keepTitles) && raw.keepTitles.length ? raw.keepTitles : DEFAULTS.keepTitles,
        renameTo: typeof raw.renameTo === "string" ? raw.renameTo : "",
      };
    } catch {
      /* fall back to defaults */
    }
  } else if (customization) {
    config.enabled = customization.enabled;
  }
  return { functionId: fn?.id ?? null, customizationId: customization?.id ?? null, config };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return findState(admin.graphql);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const config: Config = {
    enabled: form.get("enabled") === "on" || form.get("enabled") === "true",
    keepTitles: String(form.get("keepTitles") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    renameTo: String(form.get("renameTo") ?? "").trim().slice(0, 80),
  };
  if (!config.keepTitles.length) config.keepTitles = DEFAULTS.keepTitles;

  const state = await findState(admin.graphql);
  if (!state.functionId) {
    return { ok: false, message: "The checkout function is not available yet. Reinstall the app or try again in a minute." };
  }
  const metafields = [{ namespace: NAMESPACE, key: KEY, type: "json", value: JSON.stringify(config) }];

  type Result = { userErrors: { field: string[] | null; message: string }[] };
  if (state.customizationId) {
    const r = await gql<{ deliveryCustomizationUpdate: Result }>(
      admin.graphql,
      `#graphql
      mutation B2BShippingUpdate($id: ID!, $input: DeliveryCustomizationInput!) {
        deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) { userErrors { field message } }
      }`,
      { id: state.customizationId, input: { title: TITLE, enabled: config.enabled, metafields } },
    );
    if (r.deliveryCustomizationUpdate.userErrors.length) {
      return { ok: false, message: r.deliveryCustomizationUpdate.userErrors.map((e) => e.message).join("; ") };
    }
  } else {
    const r = await gql<{ deliveryCustomizationCreate: Result }>(
      admin.graphql,
      `#graphql
      mutation B2BShippingCreate($input: DeliveryCustomizationInput!) {
        deliveryCustomizationCreate(deliveryCustomization: $input) { userErrors { field message } }
      }`,
      { input: { functionHandle: FUNCTION_HANDLE, title: TITLE, enabled: config.enabled, metafields } },
    );
    if (r.deliveryCustomizationCreate.userErrors.length) {
      return { ok: false, message: r.deliveryCustomizationCreate.userErrors.map((e) => e.message).join("; ") };
    }
  }
  return { ok: true, message: config.enabled ? "Saved — the rule is on." : "Saved — the rule is off." };
};

export default function Index() {
  const { config, customizationId, functionId } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="B2B shipping rules">
      <s-section heading="What this does">
        <s-paragraph>
          When a business (B2B) buyer checks out, only the shipping option(s) you keep below are shown, so carrier
          options such as UPS, FedEx, DHL or USPS don't appear on wholesale orders. Retail checkouts are never changed.
          Store pickup and local delivery stay available.
        </s-paragraph>
        <s-paragraph>
          Safety: a B2B checkout is never left without a shipping option — if none of your kept options is offered for
          an address, the cheapest shipping option stays.
        </s-paragraph>
        {!functionId && (
          <s-banner tone="warning">The checkout function is still being installed. Refresh in a minute.</s-banner>
        )}
        {functionId && !customizationId && (
          <s-banner tone="info">Not active yet — press Save to turn the rule on for your store.</s-banner>
        )}
      </s-section>

      <s-section heading="Settings">
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-checkbox name="enabled" value="on" label="Turn the rule on" defaultChecked={config.enabled} />
            <s-text-field
              name="keepTitles"
              label="Shipping options to keep for B2B buyers"
              details="Exact names as they appear at checkout, separated by commas. Example: Standard"
              defaultValue={config.keepTitles.join(", ")}
            />
            <s-text-field
              name="renameTo"
              label="Show the kept option as (optional)"
              details="Leave empty to keep the original name. Example: Shipping — billed after packing"
              defaultValue={config.renameTo}
              maxLength={80}
            />
            <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
              Save
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
