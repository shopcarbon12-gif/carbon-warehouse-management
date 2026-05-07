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
      { id: "edit", label: "Add / edit customers" },
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
