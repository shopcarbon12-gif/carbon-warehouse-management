/**
 * Public privacy policy (linked from the App Store listing).
 */
export const meta = () => [{ title: "Privacy policy — Carbon B2B Shipping Rules" }];

export default function Privacy() {
  return (
    <main style={{ maxWidth: 760, margin: "48px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6, color: "#1a1a1a" }}>
      <h1>Privacy policy</h1>
      <p><strong>Carbon B2B Shipping Rules</strong> is a Shopify app that changes which shipping options a business (B2B) buyer sees at checkout.</p>
      <h2>What we collect</h2>
      <p>When a store installs the app, Shopify gives the app an access token for that store. We keep that token (and the store's domain) only so the app can save the store's shipping settings. The settings themselves are stored inside the store's own Shopify account.</p>
      <p>The app does not collect, store or share any customer, order or payment information. The checkout rule runs inside Shopify; we never receive the buyer's details.</p>
      <h2>Permissions</h2>
      <p>The app asks only for permission to read and write delivery customizations — the setting that hides or renames shipping options at checkout.</p>
      <h2>Deleting data</h2>
      <p>When the app is uninstalled, or when Shopify sends a store-deletion request, we delete the store's access token. There is no customer data to delete.</p>
      <h2>Contact</h2>
      <p>Questions: <a href="mailto:support@shopcarbon.com">support@shopcarbon.com</a></p>
      <p style={{ color: "#666", fontSize: 14 }}>Last updated: November 8, 2026</p>
    </main>
  );
}
