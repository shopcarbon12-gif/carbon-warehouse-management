/**
 * Canonical page/section tree for POS Role permissions.
 *
 * Stored as JSONB on user_roles.permissions for rows where scope='pos'.
 * Same shape as APP_PERMISSION_PAGES (omitted keys default to "view"), so the
 * existing RolePermissionsModal renders this catalog with no special-casing.
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
      { id: "sales_history", label: "Sales history" },
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
      { id: "discounts", label: "Discounts applied" },
      { id: "refunds", label: "Refunds & voids" },
      { id: "cash_drawer", label: "Cash drawer log" },
    ],
  },
  {
    id: "pos_customers",
    label: "Customers",
    sections: [
      { id: "view", label: "View customers" },
      // `edit` historically covered both add and edit; split per operator
      // request 2026-05-28 so cashier roles can be granted "add new
      // customer at checkout" without granting "edit existing customer
      // records" (which can touch loyalty / store-credit balances).
      //
      // Existing role rows that have edit:"view" continue to be treated
      // as granting both add and edit on the POS side — the role-modal
      // hydrator surfaces them as such until an admin re-saves. New
      // roles start with both add + edit defaulting to "view" the same
      // way the merged section did.
      { id: "add", label: "Add customer" },
      { id: "edit", label: "Edit customer" },
      { id: "store_credit", label: "Adjust store credit" },
    ],
  },
  {
    id: "pos_employees",
    label: "Employees",
    sections: [
      { id: "view", label: "View employees" },
      { id: "edit", label: "Add / edit employees" },
      { id: "reset_pin", label: "Reset PIN" },
    ],
  },
  {
    id: "pos_settings",
    label: "Settings",
    sections: [
      { id: "locations", label: "Locations" },
      { id: "registers", label: "Registers" },
      { id: "discounts", label: "Discount rules" },
      { id: "readers", label: "Stripe readers" },
    ],
  },
];
