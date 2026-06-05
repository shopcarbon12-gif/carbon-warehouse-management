# Carbon WMS — Mobile Permission Catalog (Settings → POS Roles)

> Complete breakdown of every mobile screen, action, and sensitive field so a role
> can be configured for **who can VIEW, who can EDIT, and what data is HIDDEN**
> (e.g. hide item cost from employees). This is the spec the desktop POS-roles
> editor + mobile enforcement implement against.
> Generated 2026-06-05.

---

## 1. How permissions work today (baseline)

- A mobile role is a row in `user_roles` where `scope = 'mobile'`. A user is linked via `users.mobile_role_id` (NULL = full access).
- The role's `permissions` is a **jsonb** blob, today shaped `{ pageId: { sectionId: "view" | "hide" } }`. Empty `{}` or role name "Super Admin" = full access.
- `GET /api/mobile/permissions` flattens this to a `hiddenScreens: string[]` and the device's only enforcement is `canView(screenId)` (hide-or-show the whole screen). **There is no edit/read/field-level control yet**, and the richer `permissions` map already travels to the device but is ignored.

## 2. Proposed model (extends the existing jsonb — NO DB migration)

Per screen, a role gets a **capability tier** plus optional **action gates** and **field flags**:

```jsonc
permissions: {
  "<module>": {                      // page group, e.g. "inventory"
    "<screenId>": {
      "cap": "hidden" | "view" | "edit",     // tier (legacy "hide"==hidden, "view"==view)
      "actions": { "<actionId>": false },    // per-action perform gate (default true when cap=edit)
      "fields":  { "show_cost": false }      // field/element visibility (default true)
    }
  }
}
```

**Capability tiers**

| Tier | Meaning |
|------|---------|
| `hidden` | Screen is not shown; its hub tile disappears; route is blocked. |
| `view` | Operator can open + read the screen, but every mutating action is disabled (read-only). |
| `edit` | Full access — can open + perform actions (subject to per-action gates). |

**Action gates** — for screens with several distinct mutating actions you may want to split (e.g. allow *Assign to bin* but deny *Delete bin*). Each is `true` by default at `edit`; set `false` to deny just that action.

**Field flags** — global-or-per-screen toggles that hide sensitive data. Default **true** (visible). Set **false** to hide.

Backward compatible: a bare `"hide"`/`"view"` string is still accepted and means `cap` only.

## 3. Global field flags (apply everywhere the field appears)

These are the "who can see what data" switches. The headline one you asked for is **`show_cost`**.

| Flag | Hides | Where it appears on mobile today |
|------|-------|----------------------------------|
| `show_cost` | Cost / wholesale / landed `default_cost` / margin / profit | **Not shown on mobile today** — reserved so cost can never leak if a future screen or the desktop catalog surfaces it. Wire it now so the toggle exists. |
| `show_retail_price` | Retail selling price (`$XX.XX`) | Item Lookup (RETAIL tile), Catalog row, Count item card, Locate item card, EPC list header |
| `show_vendor` | Vendor / brand / supplier | Item Lookup card, Catalog filter + row |
| `show_on_hand` | On-hand / live EPC quantity (`xN`) | Item Lookup (ON HAND), Catalog qty badge, Count counters, Transfer Out search |
| `show_system_ids` | Lightspeed system_id / serial / EPC internals | Encode, Test Tag, Re-Encode report, Encode-Commission report |
| `show_actor_names` | "First L." operator attribution | All reports (Counts, Status, Damages, Re-Encode, Transfers) |

> Recommendation: `show_cost` and `show_retail_price` are the two an **employee** role would typically have set to **false**; managers keep them true.

---

## 4. Screen-by-screen catalog (by module)

Legend per row: **Tiers** = which capability tiers make sense • **Action gates** = splittable perform actions • **Field flags** = sensitive data on that screen.

### AUTH (never role-gated — security is server-side)
| Screen | ScreenId | Notes |
|--------|----------|-------|
| Login | `login` | Always allowed. Security = device authorization (admin approves Android ID in WMS desktop) + biometric (OS). Not a role toggle. |
| Device Lock | `device_lock` | Always allowed. Shown when device not authorized. Admin-only unlock is the desktop device-binding approval. |

### DASHBOARD
| Screen | ScreenId | Tiers | Action gates | Field flags |
|--------|----------|-------|--------------|-------------|
| Dashboard | `dashboard` | hidden/view/edit | `change_location`, `download_ota`, `refresh_settings`, `sign_out` | (KPIs are aggregates — none) |

### INVENTORY
| Screen | ScreenId | Tiers | Action gates | Field flags |
|--------|----------|-------|--------------|-------------|
| Inventory Hub | `inventory_hub` | hidden/view | — (router) | — |
| Catalog | `inventory_catalog` | hidden/view | — (read-only screen) | `show_retail_price`, `show_vendor`, `show_on_hand`, `show_cost` |
| Item Lookup | `inventory_lookup` | hidden/view | `adjust_rfid_power` | `show_retail_price`, `show_vendor`, `show_on_hand`, `show_cost` |
| Count Inventory | `count_inventory` | hidden/view/edit | `start_stop_scan`, `delete_item`, `upload_count`, `save_count`, `export_csv`, `change_settings` | `show_retail_price`, `show_on_hand` |
| Add-On Catalog (scan unknowns) | `add_on_catalog` | hidden/view/edit | `start_stop_scan`, `upload`, `save`, `export_csv` | `show_retail_price`, `show_on_hand` |
| Add-On Count — picker | `add_on_count_source_picker` | hidden/view/edit | `start_session`, `resume_session`, `request_join`, `reopen_completed` (super-admin) | `show_actor_names` |
| Add-On Count — scan | `add_on_count` | hidden/view/edit | `start_stop_scan`, `approve_join_request`, `review` | — |
| Add-On Count — review | `add_on_count_review` | hidden/view/edit | `save`, `upload` | — |
| Add-On Count — settings | `add_on_count_settings` | hidden/view/edit | `toggle_vibrate` | — |
| CSV Session | `inventory_csv_session` | hidden/view/edit | `upload`, `save` | `show_retail_price`, `show_on_hand` |

### BIN MANAGEMENT
| Screen | ScreenId | Tiers | Action gates | Field flags |
|--------|----------|-------|--------------|-------------|
| Bin Assign (Fast Putaway) | `fast_putaway` | hidden/view/edit | `assign_item`, `create_bin`, `move_or_add`, **`clean_bin`**, **`delete_bin`**, `undo`, `enable_multi_items`, `change_location` | — |
| Clean Bin | `clean_bin` | hidden/view/edit | **`clean_empty_bin`**, `undo_clean` | — |
| Bin Assign Settings | `bin_assign_settings` | hidden/view/edit | `toggle_manual_mode`, `toggle_camera`, `toggle_external_scanner` | — |
| EPC Detail (drilldown) | `epc_detail` | hidden/view | `locate` | `show_system_ids` |

> The bolded `clean_bin` / `delete_bin` / `clean_empty_bin` are destructive — a common config is `edit` on Bin Assign but those two actions denied for line staff.

### TAGS & LABELS / ENCODE
| Screen | ScreenId | Tiers | Action gates | Field flags |
|--------|----------|-------|--------------|-------------|
| Encode (single) | `encode` | hidden/view/edit | `mint_epc`, `write_chip`, `finalize`, `print_label`, `change_status`, `adjust_rfid_power` | `show_system_ids` |
| Encode & Print | `encode_and_print` | hidden/view/edit | `mint_epc`, `write_chip`, `finalize`, `print_label`, `change_status`, `adjust_rfid_power` | `show_system_ids` |
| Test Encoded Tag | `encode_test_tag` | hidden/view | `adjust_rfid_power` | `show_system_ids` |
| Re-Encode (Search & Encode) | `search_and_encode` | hidden/view/edit | `mint_epc`, `write_chip`, `finalize`, `rollback`, `upload_csv`, `change_extract_settings`, `adjust_rfid_power` | `show_system_ids` |
| Print (RFID + non-RFID) | `print` / `print_non_rfid` | hidden/view/edit | `commission_rfid`, `print_label`, `set_add_to_inventory`, `set_qty` | `show_on_hand` |
| Barcode Intake | `barcode_intake` | hidden/view/edit | `intake_scan`, `commit` | — |
| Status Change (scan) | `status_change` | hidden/view/edit | `start_stop_scan`, `remove_row`, `adjust_rfid_power` | — |
| Status Pick (commit) | `status_pick` | hidden/view/edit | `commit_status`, **`override_risky`** (super-admin) | — |

> `override_risky` (e.g. forcing in-stock→sold) is already super-admin gated in code — surface it as an explicit action toggle.

### FIND & LOCATE
| Screen | ScreenId | Tiers | Action gates | Field flags |
|--------|----------|-------|--------------|-------------|
| Geiger Search | `geiger_search` | hidden/view | `locate` | `show_on_hand` |
| Cloud + Geiger | `cloud_geiger` | hidden/view/edit | `bulk_find`, `dismiss_row`, `dismiss_all`, `upload_csv`, `adjust_rfid_power` | — |
| Locate Tag (Geiger) | `locate_tag` | hidden/view | `take_action` (opens Status/Encode/Re-Encode — each still gated by its own screen), `adjust_rfid_power` | `show_retail_price`, `show_system_ids` |

### TRANSFERS
| Screen | ScreenId | Tiers | Action gates | Field flags |
|--------|----------|-------|--------------|-------------|
| Transfer Out | `transfer_out` | hidden/view/edit | `add_rfid`, `add_manual`, `commit_transfer`, `print_slip`, `adjust_rfid_power` | `show_on_hand` |
| Transfer In — pending list | `transfer_in_pending` | hidden/view | `refresh` | — |
| Transfer In — receive | `transfer_in_receive` | hidden/view/edit | `ingest`, `set_nonlive_status`, `commit_receive`, `print_slip`, `adjust_rfid_power` | — |

### REPORTS (mostly read-only; the gate is VIEW + can-export)
| Screen | ScreenId | Tiers | Action gates | Field flags |
|--------|----------|-------|--------------|-------------|
| Reports Hub | `reports_hub` | hidden/view | — (router) | — |
| Counts report | `count_reports` | hidden/view | `export_csv` | `show_actor_names` |
| Status Change report | `status_reports` | hidden/view | `export_csv` | `show_actor_names` |
| Damages report | `damages_reports` | hidden/view | `export_csv` | `show_actor_names` |
| Re-Encode report | `re_encode_reports` | hidden/view | `export_csv` | `show_system_ids`, `show_actor_names` |
| Transfer Out report | `transfer_out_reports` | hidden/view | `export_csv` | `show_actor_names` |
| Transfer In report | `transfer_in_pending` (in-direction) | hidden/view | `export_csv` | `show_actor_names` |
| Encode-Commission report | `encode_commission_report` (new id) | hidden/view | `export_csv` | `show_system_ids`, `show_actor_names` |
| Add-On Catalog report | `add_on_catalog_report` (new id) | hidden/view | `export_csv` | `show_system_ids`, `show_actor_names` |
| Label Print report | `label_print_report` (new id) | hidden/view | `export_csv` | `show_actor_names` |
| Bin Clearance report | `bin_clearance_report` (new id) | hidden/view | `refresh` | `show_actor_names` |

> `export_csv` as an action lets you allow viewing a report but deny downloading/exfiltrating the data.

### SETTINGS & SECURITY
| Screen | ScreenId | Tiers | Action gates (each setting) | Field flags |
|--------|----------|-------|------------------------------|-------------|
| Handheld Settings | `handheld_settings` | hidden/view/edit | `check_ota`, `set_antenna_power`, `set_scanner_source`, `open_device_scanner_settings`, `open_android_permissions`, `toggle_sound`, `set_volume`, `toggle_biometric` | — |

> A line-staff role might get `handheld_settings: view` (see values, change nothing) or `edit` with `set_antenna_power` denied (power is a hardware-sensitive control).

---

## 5. Catalog drift to fix during implementation
The server `MOBILE_PERMISSION_PAGES` is missing ids that exist in the Dart `ScreenIds`, so today they can **never** be hidden (fail-open): `add_on_catalog`, `transfer_in_receive`, `transfer_reports_hub`, `encode_and_print`, `locate_tag`, `epc_detail`, `re_encode_reports`. The new catalog must include every screen above so all are controllable.

## 6. Implementation path (what building this requires)
1. **Shared catalog** (`lib/settings/mobile-permission-catalog.ts`): expand to the full module→screen→{actions, fields} tree above (single source of truth for the desktop editor + the API).
2. **Widen zod** in `app/api/settings/access/user-roles/route.ts` (POST) and `[id]/route.ts` (PUT): value becomes `string | { cap, actions?, fields? }`. (No DB migration — jsonb already holds it.)
3. **Desktop editor** (`components/settings/mobile-access-panel.tsx` → `MobileRolePermissionsModal`): per screen render a 3-way **Hidden / View / Edit** control, an expandable list of **action** checkboxes, and the **field-flag** checkboxes (incl. *Show cost*, *Show retail price*).
4. **`GET /api/mobile/permissions`**: emit the full per-screen `{cap, actions, fields}` (keep `hiddenScreens` for old clients).
5. **Mobile `mobile_permissions.dart`**: add `capOf(screenId)`, `canEdit(screenId)`, `canDo(screenId, actionId)`, `showField(flag)` and consume them in screens (gate action buttons + hide flagged fields/price).
6. **Enforcement audit**: server endpoints must also honor the gates (defense-in-depth) so a modified client can't bypass `edit`/action denials.
