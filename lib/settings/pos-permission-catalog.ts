/**
 * Canonical page/section tree for POS Role permissions.
 *
 * Stored as JSONB on user_roles.permissions for rows where scope='pos'.
 * Same shape as APP_PERMISSION_PAGES (omitted keys default to "view"), so the
 * existing RolePermissionsModal renders this catalog with no special-casing.
 *
 * 2026-05-28: expanded to reflect every cashier-visible page on
 * pos.shopcarbon.com (Inventory / Update Status Item, Loyalty redeem at
 * checkout, Gift cards, Discounts at checkout, Tips, Returns w/ no
 * receipt, etc.). The earlier list was a stub that only covered Sales /
 * Register / Reports / Customers / Employees / Settings at the top
 * level — operators couldn't grant or deny anything in between.
 */

import type { PermissionPageDef } from "./permission-catalog";

export const POS_PERMISSION_PAGES: PermissionPageDef[] = [
  {
    id: "pos_sales",
    label: "Sales",
    sections: [
      { id: "new_sale", label: "New sale" },
      { id: "exchange", label: "Exchange" },
      { id: "refund", label: "Refund" },
      { id: "refund_no_receipt", label: "Refund without receipt" },
      { id: "void_sale", label: "Void open sale" },
      { id: "park_sale", label: "Park / resume sale" },
      { id: "sales_history", label: "Sales history" },
      { id: "discount_at_checkout", label: "Apply discount at checkout" },
      { id: "tip", label: "Apply tip" },
      { id: "gift_card_sell", label: "Sell gift card" },
      { id: "gift_card_redeem", label: "Redeem gift card" },
      { id: "loyalty_redeem", label: "Redeem loyalty points at checkout" },
    ],
  },
  {
    id: "pos_register",
    label: "Register",
    sections: [
      { id: "open_register", label: "Open register" },
      { id: "switch_register", label: "Switch register" },
      { id: "close_register", label: "Close register" },
      { id: "cash_drop", label: "Cash drop / payout" },
      { id: "add_amount", label: "Add amount (cash-in)" },
      { id: "no_sale_open_drawer", label: "No-sale open drawer" },
      { id: "blind_count", label: "Blind close-out count" },
    ],
  },
  {
    id: "pos_inventory",
    label: "Inventory (POS)",
    sections: [
      { id: "update_status_item", label: "Update Status Item (RFID re-scan)" },
      { id: "view_stock", label: "View on-hand stock" },
      { id: "lookup_by_barcode", label: "Lookup by barcode" },
      { id: "lookup_by_rfid", label: "Lookup by RFID tag" },
      { id: "price_lookup", label: "Price lookup" },
    ],
  },
  {
    id: "pos_reports",
    label: "Reports",
    sections: [
      { id: "end_of_day", label: "End of day" },
      { id: "sales_tax", label: "Sales tax" },
      { id: "by_product", label: "Sales by product" },
      { id: "by_employee", label: "Sales by employee" },
      { id: "by_register", label: "Sales by register" },
      { id: "by_hour", label: "Sales by hour" },
      { id: "discounts", label: "Discounts applied" },
      { id: "refunds", label: "Refunds & voids" },
      { id: "cash_drawer", label: "Cash drawer log" },
      { id: "tips_report", label: "Tips report" },
      { id: "gift_card_liability", label: "Gift card liability" },
    ],
  },
  {
    id: "pos_customers",
    label: "Customers",
    sections: [
      { id: "view", label: "View customers" },
      // Split per operator request 2026-05-28: cashier roles can be granted
      // "add new customer at checkout" without granting "edit existing
      // customer records" (which can touch loyalty / store-credit
      // balances). Existing role rows with edit:"view" still grant both
      // add + edit until an admin re-saves the role.
      { id: "add", label: "Add customer" },
      { id: "edit", label: "Edit customer" },
      { id: "store_credit", label: "Adjust store credit" },
      { id: "loyalty_adjust", label: "Adjust loyalty points (manual)" },
      { id: "merge_customers", label: "Merge duplicate customers" },
      { id: "delete_customer", label: "Delete / anonymize customer" },
    ],
  },
  {
    id: "pos_employees",
    label: "Employees",
    sections: [
      { id: "view", label: "View employees" },
      { id: "add", label: "Add employee" },
      { id: "edit", label: "Edit employee" },
      { id: "reset_pin", label: "Reset PIN" },
      { id: "reset_password", label: "Reset POS password" },
      { id: "deactivate", label: "Archive / unarchive" },
      { id: "delete", label: "Delete permanently (Super Admin)" },
      { id: "view_timecards", label: "View timecards" },
    ],
  },
  {
    id: "pos_settings",
    label: "Settings",
    sections: [
      { id: "locations", label: "Locations" },
      { id: "registers", label: "Registers" },
      { id: "discounts", label: "Discount rules" },
      { id: "tax_rules", label: "Tax rules" },
      { id: "tip_presets", label: "Tip presets" },
      { id: "receipts", label: "Receipt templates" },
      { id: "readers", label: "Stripe / card readers" },
      { id: "rfid_readers", label: "RFID readers (POS slot)" },
      { id: "loyalty_program", label: "Loyalty program settings" },
      { id: "gift_cards", label: "Gift card configuration" },
    ],
  },
];
