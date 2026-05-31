"use client";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createPortal } from "react-dom";
import { type CSSProperties, type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const DEBUG_INGEST_URL = "http://127.0.0.1:7510/ingest/a563c88f-df2a-4570-a887-c7a3035d0692";
const DEBUG_INGEST_ENABLED =
  String(process.env.NEXT_PUBLIC_COLLECTION_MAPPING_DEBUG_INGEST || "")
    .trim()
    .toLowerCase() === "true";
const TREE_RENDER_INITIAL_LIMIT = 350;
const TREE_RENDER_STEP = 200;

function debugIngest(payload: Record<string, unknown>) {
  if (!DEBUG_INGEST_ENABLED) return;
  fetch(DEBUG_INGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "9da838" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

type DropPosition = "before" | "after" | "inside";
type MenuLinkType = "COLLECTION" | "PRODUCT" | "PAGE" | "BLOG";
type MenuLinkTargetOption = {
  id: string;
  title: string;
  handle: string;
  url: string;
};
type MenuLinkTargets = {
  collections: MenuLinkTargetOption[];
  products: MenuLinkTargetOption[];
  pages: MenuLinkTargetOption[];
  blogs: MenuLinkTargetOption[];
};
type UndoToolbarEntry = {
  id: string;
  title: string;
  details: string[];
};

type MenuNode = {
  nodeKey: string;
  label: string;
  parentKey: string | null;
  depth: number;
  enabled: boolean;
  collectionId: string | null;
  linkedTargetType?: string;
  linkedTargetLabel?: string;
  linkedTargetResourceId?: string | null;
  linkedTargetUrl?: string | null;
};

type DropTarget = { targetKey: string; position: DropPosition } | null;

type ShopifyMenuItemsTreeProps = {
  menuTitle: string;
  menuHandle: string;
  treeSearch: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onCollapseTreeCards: () => void;
  onTreeSearchChange: (value: string) => void;
  onTreeSearchSubmit: (value: string) => void;
  onRefreshTree: () => void;
  onSaveTree: () => Promise<void>;
  undoEntries: UndoToolbarEntry[];
  undoMenuOpen: boolean;
  onUndoMenuToggle: () => void;
  onUndoEntrySelect: (entryId: string) => void;
  saving: boolean;
  nodes: MenuNode[];
  nodeByKey: Map<string, MenuNode>;
  childrenByParent: Map<string, string[]>;
  visibleTreeNodeIdSet: Set<string>;
  expandedNodes: Record<string, boolean>;
  selectedNodes: Record<string, boolean>;
  unmappedCollections: Array<{ id: string; title: string; selected: boolean }>;
  onMoveNode: (sourceKey: string, target: DropTarget) => Promise<void>;
  onInlineEditNode: (
    node: MenuNode,
    next: {
      label: string;
      linkValue: string;
      linkType?: MenuLinkType;
      linkTargetId?: string | null;
      linkTargetLabel?: string;
    }
  ) => Promise<void>;
  inlineLinkTargets: MenuLinkTargets;
  onApplyNodeSelection: (nodeKey: string) => void;
  onToggleNodeExpansion: (nodeKey: string) => void;
  onToggleNodeVisibility: (nodeKey: string) => void;
  onOpenEditEditor: (node: MenuNode) => void;
  onOpenAddEditor: (parentKey: string | null) => void;
  onDeleteNode: (nodeKey: string) => void;
  onToggleUnmappedCollection: (collectionId: string) => void;
  onReorderUnmappedCollections: (sourceCollectionId: string, targetCollectionId: string) => void;
  onEditUnmappedCollection: (collectionId: string, title: string) => Promise<void>;
  onDeleteUnmappedCollection: (collectionId: string) => void;
};

type RowProps = {
  id: string;
  checked: boolean;
  dragging: boolean;
  dropState: string;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  label: string;
  enabled: boolean;
  targetLabel: string;
  showTargetLabel: boolean;
  isInlineEditing: boolean;
  inlineLabel: string;
  inlineLink: string;
  inlineLinkType: MenuLinkType;
  inlineLinkQuery: string;
  inlineLinkOptions: MenuLinkTargetOption[];
  inlineLinkPickerOpen: boolean;
  inlineLinkPickerMode: "categories" | "results";
  inlineSaving: boolean;
  onRowClick: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onToggleVisibility: () => void;
  onInlineLabelChange: (value: string) => void;
  onInlineLinkChange: (value: string) => void;
  onInlineLinkTypeChange: (value: MenuLinkType) => void;
  onInlineLinkQueryChange: (value: string) => void;
  onInlineLinkModeChange: (mode: "categories" | "results") => void;
  onInlineLinkPickerOpen: () => void;
  onInlineLinkPickerClose: () => void;
  onInlineLinkOptionSelect: (option: MenuLinkTargetOption) => void;
  onInlineSave: () => void;
  onInlineCancel: () => void;
  onDelete: () => void;
};

function SortableTreeRow({
  id,
  checked,
  dragging,
  dropState,
  depth,
  hasChildren,
  isExpanded,
  label,
  enabled,
  targetLabel,
  showTargetLabel,
  isInlineEditing,
  inlineLabel,
  inlineLink,
  inlineLinkType,
  inlineLinkQuery,
  inlineLinkOptions,
  inlineLinkPickerOpen,
  inlineLinkPickerMode,
  inlineSaving,
  onRowClick,
  onToggle,
  onEdit,
  onToggleVisibility,
  onInlineLabelChange,
  onInlineLinkChange,
  onInlineLinkTypeChange,
  onInlineLinkQueryChange,
  onInlineLinkModeChange,
  onInlineLinkPickerOpen,
  onInlineLinkPickerClose,
  onInlineLinkOptionSelect,
  onInlineSave,
  onInlineCancel,
  onDelete,
}: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const linkTriggerRef = useRef<HTMLDivElement | null>(null);
  const pickerPanelRef = useRef<HTMLDivElement | null>(null);
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0, width: 320 });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ["--tree-depth"]: String(depth),
  } as CSSProperties;

  useLayoutEffect(() => {
    if (!inlineLinkPickerOpen) return;
    const updatePosition = () => {
      const trigger = linkTriggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const maxWidth = 360;
      const minWidth = 300;
      const width = Math.max(minWidth, Math.min(maxWidth, rect.width));
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      setPickerPosition({
        top: rect.bottom + 4,
        left,
        width,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [inlineLinkPickerOpen]);

  useEffect(() => {
    if (!inlineLinkPickerOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (pickerPanelRef.current?.contains(target)) return;
      if (linkTriggerRef.current?.contains(target)) return;
      onInlineLinkPickerClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onInlineLinkPickerClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [inlineLinkPickerOpen, onInlineLinkPickerClose]);

  const inlineSaveDisabled = inlineSaving || !inlineLabel.trim() || !inlineLink.trim();

  useEffect(() => {
    if (!isInlineEditing) return;
    // #region agent log
    debugIngest({
        sessionId: "9da838",
        runId: "label-save-debug",
        hypothesisId: "H1",
        location: "components/shopify-menu-items-tree.tsx:SortableTreeRow",
        message: "inline_save_state_probe",
        data: {
          id,
          inlineSaving,
          hasInlineLabel: Boolean(inlineLabel.trim()),
          hasInlineLink: Boolean(inlineLink.trim()),
          inlineSaveDisabled,
        },
        timestamp: Date.now(),
      });
    // #endregion
  }, [id, isInlineEditing, inlineSaving, inlineLabel, inlineLink, inlineSaveDisabled]);

  return (
    <div
      ref={setNodeRef}
      className={`treeRow tree-card ${checked ? "active" : ""} ${dragging || isDragging ? "dragging" : ""} ${dropState} ${isInlineEditing ? "editing" : ""} ${enabled ? "" : "hidden-node"}`}
      style={style}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        // #region agent log
        debugIngest({
            sessionId: "9da838",
            runId: "multi-select-debug",
            hypothesisId: "H2",
            location: "components/shopify-menu-items-tree.tsx:SortableTreeRow",
            message: "row_click_modifier_probe",
            data: {
              id,
              ctrlKey: Boolean(event.ctrlKey),
              metaKey: Boolean(event.metaKey),
              shiftKey: Boolean(event.shiftKey),
              isInlineEditing,
            },
            timestamp: Date.now(),
          });
        // #endregion
        onRowClick();
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement | null;
        const targetTag = String(target?.tagName || "").toUpperCase();
        const isTypingTarget =
          targetTag === "INPUT" ||
          targetTag === "TEXTAREA" ||
          Boolean(target?.isContentEditable) ||
          Boolean(target?.closest("input, textarea, [contenteditable='true']"));
        if (isTypingTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onRowClick();
        }
      }}
    >
      <span className="dragHandle" title="Move menu item" {...attributes} {...listeners}>
        <svg viewBox="0 0 10 14" width="10" height="14">
          <circle cx="2" cy="2" r="1.1" />
          <circle cx="8" cy="2" r="1.1" />
          <circle cx="2" cy="7" r="1.1" />
          <circle cx="8" cy="7" r="1.1" />
          <circle cx="2" cy="12" r="1.1" />
          <circle cx="8" cy="12" r="1.1" />
        </svg>
      </span>
      {hasChildren ? (
        <button
          type="button"
          className="treeToggle"
          aria-label={isExpanded ? "Collapse menu item" : "Expand menu item"}
          aria-expanded={isExpanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" className={isExpanded ? "" : "collapsed"}>
            <path d="M2 4l4 4 4-4H2z" />
          </svg>
        </button>
      ) : (
        <span className="treeToggleSpacer" aria-hidden="true" />
      )}
      {isInlineEditing ? (
        <div className="treeText treeTextEditing" onClick={(event) => event.stopPropagation()}>
          <label className="treeInlineField">
            <span className="treeInlineFieldLabel">Label</span>
            <input
              className="treeInlineInput"
              style={{
                fontSize: "13px",
                fontWeight: 600,
                color: "#e6edf7",
                lineHeight: "normal",
                fontFamily: "inherit",
                height: "40px",
                minHeight: "30px",
                padding: "0 4px",
                boxSizing: "border-box",
              }}
              value={inlineLabel}
              onChange={(event) => onInlineLabelChange(event.target.value)}
              placeholder="Menu item label"
              autoFocus
            />
          </label>
          <label className="treeInlineField">
            <span className="treeInlineFieldLabel">Link</span>
            <div className="treeInlineLinkPickerWrap" ref={linkTriggerRef} onClick={(event) => event.stopPropagation()}>
              <input
                className="treeInlineInput treeInlineInputLinkTrigger"
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#e6edf7",
                  lineHeight: "normal",
                  fontFamily: "inherit",
                  height: "40px",
                  minHeight: "30px",
                  padding: "0 4px",
                  boxSizing: "border-box",
                }}
                value={inlineLink}
                onClick={onInlineLinkPickerOpen}
                onChange={(event) => onInlineLinkChange(event.target.value)}
                placeholder="Link target"
              />
            </div>
            {inlineLinkPickerOpen && typeof document !== "undefined"
              ? createPortal(
                  <div
                    className="treeInlineLinkPicker treeInlineLinkPickerPortal"
                    ref={pickerPanelRef}
                    style={{
                      position: "fixed",
                      top: `${pickerPosition.top}px`,
                      left: `${pickerPosition.left}px`,
                      width: `${pickerPosition.width}px`,
                    }}
                  >
                    {inlineLinkPickerMode === "categories" ? (
                      <div className="treeInlineLinkCategories">
                        {(["COLLECTION", "PRODUCT", "PAGE", "BLOG"] as MenuLinkType[]).map((type) => (
                          <button
                            key={type}
                            type="button"
                            className="treeInlineLinkCategoryOption"
                            onClick={() => {
                              onInlineLinkTypeChange(type);
                              onInlineLinkModeChange("results");
                            }}
                          >
                            <span>
                              {type === "COLLECTION"
                                ? "Collections"
                                : type === "PRODUCT"
                                  ? "Products"
                                  : type === "PAGE"
                                    ? "Pages"
                                    : "Blogs"}
                            </span>
                            <span aria-hidden>›</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div className="treeInlineLinkResultsHead">
                          <button
                            type="button"
                            className="treeInlineLinkBackBtn"
                            onClick={() => onInlineLinkModeChange("categories")}
                          >
                            ‹ Back
                          </button>
                          <span className="treeInlineLinkResultsCount">{inlineLinkOptions.length} results</span>
                        </div>
                        <input
                          className="treeInlineLinkSearch"
                          value={inlineLinkQuery}
                          onChange={(event) => onInlineLinkQueryChange(event.target.value)}
                          placeholder={`Search ${inlineLinkType.toLowerCase()}...`}
                          autoFocus
                        />
                        <div className="treeInlineLinkOptions">
                          {inlineLinkOptions.length > 0 ? (
                            inlineLinkOptions.slice(0, 60).map((option) => (
                              <button
                                key={option.id}
                                type="button"
                                className="treeInlineLinkOption"
                                onClick={() => onInlineLinkOptionSelect(option)}
                                title={option.title}
                              >
                                {option.title}
                              </button>
                            ))
                          ) : (
                            <div className="treeInlineLinkEmpty">No results.</div>
                          )}
                        </div>
                      </>
                    )}
                    <div className="treeInlineLinkFooter">
                      <button type="button" className="treeInlineLinkCloseBtn" onClick={onInlineLinkPickerClose}>
                        Close
                      </button>
                    </div>
                  </div>,
                  document.body
                )
              : null}
          </label>
        </div>
      ) : (
        <div className="treeText">
          <span className="treeLabel">{label}</span>
          {showTargetLabel ? <span className="treeTargetLabel">{targetLabel}</span> : null}
        </div>
      )}
      <div className="treeRowActions" onClick={(event) => event.stopPropagation()}>
        {isInlineEditing ? (
          <>
            <button
              type="button"
              className="iconBtn success"
              onClick={onInlineSave}
              aria-label="Save menu item changes"
              disabled={inlineSaveDisabled}
            >
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M6.3 11.7L2.6 8l1.4-1.4 2.3 2.3 5.7-5.7L13.4 4z" />
              </svg>
            </button>
            <button type="button" className="iconBtn" onClick={onInlineCancel} aria-label="Cancel editing">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M3.3 3.3l9.4 9.4-1.4 1.4-9.4-9.4zM12.7 3.3l1.4 1.4-9.4 9.4-1.4-1.4z" />
              </svg>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={enabled ? "iconBtn eye-active" : "iconBtn danger"}
              onClick={onToggleVisibility}
              aria-label={enabled ? "Hide this menu branch on live website (save required)" : "Show this menu branch on live website (save required)"}
              title={enabled ? "Visible on website (click to hide, then Save)" : "Hidden from website (click to show, then Save)"}
            >
              {enabled ? (
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <path d="M8 3c3.6 0 6.3 2.5 7.4 4.7a.7.7 0 0 1 0 .6C14.3 10.5 11.6 13 8 13s-6.3-2.5-7.4-4.7a.7.7 0 0 1 0-.6C1.7 5.5 4.4 3 8 3zm0 1.4c-2.8 0-5 1.8-6 3.6 1 1.8 3.2 3.6 6 3.6s5-1.8 6-3.6c-1-1.8-3.2-3.6-6-3.6zm0 1.1a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <path d="M2.2 1.2l12.6 12.6-1 1L11 11.9A8.6 8.6 0 0 1 8 13c-3.6 0-6.3-2.5-7.4-4.7a.7.7 0 0 1 0-.6A10.3 10.3 0 0 1 4 4.4L1.2 2.2l1-1zm2.9 4.3A8.3 8.3 0 0 0 2 8c1 1.8 3.2 3.6 6 3.6 1 0 2-.2 2.8-.6l-1.6-1.6a2.5 2.5 0 0 1-3.4-3.4L5.1 5.5zm2-.3A2.5 2.5 0 0 1 10.8 9L7 5.2zM8 3c3.6 0 6.3 2.5 7.4 4.7a.7.7 0 0 1 0 .6 11 11 0 0 1-2.6 3.2l-1-1A9 9 0 0 0 14 8c-1-1.8-3.2-3.6-6-3.6-.8 0-1.5.1-2.2.3l-1-1A8 8 0 0 1 8 3z" />
                </svg>
              )}
            </button>
            <button type="button" className="iconBtn" onClick={onEdit} aria-label="Edit menu item">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M11.7 2.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4L6.1 12H3v-3.1l8.7-6.6zM2 13h12v1H2z" />
              </svg>
            </button>
          </>
        )}
        <button type="button" className="iconBtn deleteBtn" onClick={onDelete} aria-label="Delete menu item">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M6 2.5h4l.5 1.5H13v1H3v-1h2.5L6 2.5zm-1 3h6l-.5 7H5.5L5 5.5z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function ShopifyMenuItemsTree({
  menuTitle,
  menuHandle,
  treeSearch,
  collapsed,
  onToggleCollapse,
  onCollapseTreeCards,
  onTreeSearchChange,
  onTreeSearchSubmit,
  onRefreshTree,
  onSaveTree,
  undoEntries,
  undoMenuOpen,
  onUndoMenuToggle,
  onUndoEntrySelect,
  saving,
  nodes,
  nodeByKey,
  childrenByParent,
  visibleTreeNodeIdSet,
  expandedNodes,
  selectedNodes,
  unmappedCollections,
  onMoveNode,
  onInlineEditNode,
  inlineLinkTargets,
  onApplyNodeSelection,
  onToggleNodeExpansion,
  onToggleNodeVisibility,
  onOpenEditEditor,
  onOpenAddEditor,
  onDeleteNode,
  onToggleUnmappedCollection,
  onReorderUnmappedCollections,
  onEditUnmappedCollection,
  onDeleteUnmappedCollection,
}: ShopifyMenuItemsTreeProps) {
  const hasTreeSearch = treeSearch.trim().length > 0;
  const [dragSourceKey, setDragSourceKey] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  // Horizontal drag delta as a ref (not state): resolveDropTarget runs in
  // onDragEnd (and the onDragMove preview) where a batched state value would
  // lag the latest pointer move — the ref means the committed drop position
  // matches what the user actually sees, with no extra re-renders per move.
  const dragDeltaXRef = useRef(0);
  const [editingNodeKey, setEditingNodeKey] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [editingLink, setEditingLink] = useState("");
  const [editingLinkType, setEditingLinkType] = useState<MenuLinkType>("COLLECTION");
  const [editingLinkTargetId, setEditingLinkTargetId] = useState("");
  const [inlineLinkPickerOpen, setInlineLinkPickerOpen] = useState(false);
  const [inlineLinkPickerMode, setInlineLinkPickerMode] = useState<"categories" | "results">("categories");
  const [inlineLinkQuery, setInlineLinkQuery] = useState("");
  const [inlineSaving, setInlineSaving] = useState(false);
  const [draggingUnmappedCollectionId, setDraggingUnmappedCollectionId] = useState("");
  const [editingUnmappedCollectionId, setEditingUnmappedCollectionId] = useState("");
  const [editingUnmappedTitle, setEditingUnmappedTitle] = useState("");
  const [savingUnmappedEdit, setSavingUnmappedEdit] = useState(false);
  const [renderNodeLimit, setRenderNodeLimit] = useState(TREE_RENDER_INITIAL_LIMIT);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const visibleNodeKeys = useMemo(() => Array.from(visibleTreeNodeIdSet), [visibleTreeNodeIdSet]);
  useEffect(() => {
    setRenderNodeLimit(TREE_RENDER_INITIAL_LIMIT);
  }, [nodes, treeSearch, expandedNodes]);

  const parentByKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const node of nodes) map.set(node.nodeKey, node.parentKey || null);
    return map;
  }, [nodes]);

  const inlineLinkAssetOptions = useMemo(() => {
    const source =
      editingLinkType === "COLLECTION"
        ? inlineLinkTargets.collections
        : editingLinkType === "PRODUCT"
          ? inlineLinkTargets.products
          : editingLinkType === "PAGE"
            ? inlineLinkTargets.pages
            : inlineLinkTargets.blogs;
    const query = inlineLinkQuery.trim().toLowerCase();
    if (!query) return source;
    return source.filter((option) => option.title.toLowerCase().includes(query));
  }, [editingLinkType, inlineLinkTargets, inlineLinkQuery]);

  function resolveDropTarget(sourceKey: string, overKey: string | null): DropTarget {
    if (!overKey || sourceKey === overKey) return null;
    let targetKey = overKey;
    let position: DropPosition = "after";
    const delta = dragDeltaXRef.current;
    if (delta > 26) {
      position = "inside";
    } else if (delta < -26) {
      const parent = parentByKey.get(overKey) || null;
      if (parent) {
        targetKey = parent;
        position = "after";
      } else {
        position = "before";
      }
    } else {
      const sourceIndex = visibleNodeKeys.indexOf(sourceKey);
      const overIndex = visibleNodeKeys.indexOf(overKey);
      position = sourceIndex < overIndex ? "after" : "before";
    }
    return { targetKey, position };
  }

  async function onDragEnd(event: DragEndEvent) {
    const sourceKey = String(event.active?.id || "");
    const overKey = String(event.over?.id || "");
    if (!sourceKey || !overKey || sourceKey === overKey) {
      setDragSourceKey("");
      setDropTarget(null);
      return;
    }
    const target = resolveDropTarget(sourceKey, overKey);
    if (target) {
      setDragSourceKey(sourceKey);
      setDropTarget(target);
      await onMoveNode(sourceKey, target);
    }
    setDragSourceKey("");
    setDropTarget(null);
    dragDeltaXRef.current = 0;
  }

  function onDragMove(event: DragMoveEvent) {
    const sourceKey = String(event.active?.id || "");
    const overKey = String(event.over?.id || "");
    if (!sourceKey || !overKey) return;
    setDragSourceKey(sourceKey);
    dragDeltaXRef.current = event.delta.x || 0;
    setDropTarget(resolveDropTarget(sourceKey, overKey));
  }

  const renderBranch = (
    parentKey: string | null,
    depth: number,
    renderTracker: { count: number; keys: string[] }
  ): ReactElement[] => {
    const branchKeys = (
      parentKey
        ? childrenByParent.get(parentKey) || []
        : nodes.filter((node) => !node.parentKey).map((node) => node.nodeKey)
    ).filter((nodeKey) => visibleTreeNodeIdSet.has(nodeKey));

    const renderedNodes = branchKeys
      .map((nodeKey, index) => {
        if (renderTracker.count >= renderNodeLimit) return null;
        const node = nodeByKey.get(nodeKey);
        if (!node) return null;
        renderTracker.count += 1;
        renderTracker.keys.push(node.nodeKey);
        const checked = Boolean(selectedNodes[node.nodeKey]);
        const dragging = dragSourceKey === node.nodeKey;
        const dropState = dropTarget?.targetKey === node.nodeKey ? `drop-${dropTarget.position}` : "";
        const allChildKeys = childrenByParent.get(node.nodeKey) || [];
        const visibleChildKeys = allChildKeys.filter((childKey) =>
          visibleTreeNodeIdSet.has(childKey)
        );
        const hasChildren = allChildKeys.length > 0;
        const isExpanded = expandedNodes[node.nodeKey] === true;
        const shouldShowChildren = visibleChildKeys.length > 0;
        const branchHasAddRow = Boolean(parentKey);
        const isLastSibling = !branchHasAddRow && index === branchKeys.length - 1;
        const targetLabel = String(node.linkedTargetLabel || "").trim();
        const showTargetLabel = targetLabel.length > 0;
        const isInlineEditing = editingNodeKey === node.nodeKey;
        const initialLinkValue = String(node.linkedTargetLabel || node.linkedTargetUrl || "").trim();
        const depthStyle = { ["--tree-depth"]: String(depth) } as CSSProperties;

        return (
          <div
            key={node.nodeKey}
            className={`treeNode tree-item depth-${depth} ${depth > 0 ? "has-parent" : ""} ${isLastSibling ? "is-last" : ""} ${isInlineEditing ? "editing-node" : ""}`}
            style={depthStyle}
            data-node-key={node.nodeKey}
            data-depth={depth}
          >
            {depth > 0 ? <span className="treeConnectorElbow" aria-hidden="true" /> : null}
            {depth > 0 && !isLastSibling ? <span className="treeConnectorVertical" aria-hidden="true" /> : null}
            <SortableTreeRow
              id={node.nodeKey}
              checked={checked}
              dragging={dragging}
              dropState={dropState}
              depth={depth}
              hasChildren={hasChildren}
              isExpanded={isExpanded}
              label={node.label}
              enabled={node.enabled !== false}
              targetLabel={targetLabel}
              showTargetLabel={showTargetLabel}
              isInlineEditing={isInlineEditing}
              inlineLabel={editingLabel}
              inlineLink={editingLink}
              inlineSaving={inlineSaving}
              onRowClick={() => {
                if (isInlineEditing) return;
                onApplyNodeSelection(node.nodeKey);
              }}
              onToggle={() => onToggleNodeExpansion(node.nodeKey)}
              onToggleVisibility={() => onToggleNodeVisibility(node.nodeKey)}
              onEdit={() => {
                setEditingNodeKey(node.nodeKey);
                setEditingLabel(node.label);
                setEditingLink(initialLinkValue);
                setEditingLinkType(
                  String(node.linkedTargetType || "").trim().toUpperCase() === "PRODUCT"
                    ? "PRODUCT"
                    : String(node.linkedTargetType || "").trim().toUpperCase() === "PAGE"
                      ? "PAGE"
                      : String(node.linkedTargetType || "").trim().toUpperCase() === "BLOG"
                        ? "BLOG"
                        : "COLLECTION"
                );
                setEditingLinkTargetId(String(node.linkedTargetResourceId || "").trim());
                setInlineLinkPickerOpen(false);
                setInlineLinkPickerMode("categories");
                setInlineLinkQuery("");
              }}
              onInlineLabelChange={setEditingLabel}
              onInlineLinkChange={(value) => {
                setEditingLink(value);
                setEditingLinkTargetId("");
              }}
              inlineLinkType={editingLinkType}
              inlineLinkQuery={inlineLinkQuery}
              inlineLinkOptions={inlineLinkAssetOptions}
              inlineLinkPickerOpen={inlineLinkPickerOpen && isInlineEditing}
              inlineLinkPickerMode={inlineLinkPickerMode}
              onInlineLinkTypeChange={(value) => {
                setEditingLinkType(value);
                setEditingLinkTargetId("");
                setInlineLinkQuery("");
              }}
              onInlineLinkQueryChange={setInlineLinkQuery}
              onInlineLinkModeChange={setInlineLinkPickerMode}
              onInlineLinkPickerOpen={() => {
                setInlineLinkPickerMode("categories");
                setInlineLinkPickerOpen(true);
              }}
              onInlineLinkPickerClose={() => setInlineLinkPickerOpen(false)}
              onInlineLinkOptionSelect={(option) => {
                setEditingLink(option.title);
                setEditingLinkTargetId(option.id);
                setInlineLinkQuery(option.title);
                setInlineLinkPickerOpen(false);
                setInlineLinkPickerMode("results");
              }}
              onInlineCancel={() => {
                if (inlineSaving) return;
                setEditingNodeKey("");
                setEditingLabel("");
                setEditingLink("");
                setEditingLinkType("COLLECTION");
                setEditingLinkTargetId("");
                setInlineLinkPickerOpen(false);
                setInlineLinkPickerMode("categories");
                setInlineLinkQuery("");
              }}
              onInlineSave={async () => {
                const nextLabel = editingLabel.trim();
                const nextLink = editingLink.trim();
                if (!nextLabel || !nextLink || inlineSaving) return;
                setInlineSaving(true);
                try {
                  await onInlineEditNode(node, {
                    label: nextLabel,
                    linkValue: nextLink,
                    linkType: editingLinkType,
                    linkTargetId: editingLinkTargetId || null,
                    linkTargetLabel: nextLink,
                  });
                  setEditingNodeKey("");
                  setEditingLabel("");
                  setEditingLink("");
                  setEditingLinkType("COLLECTION");
                  setEditingLinkTargetId("");
                  setInlineLinkPickerOpen(false);
                  setInlineLinkPickerMode("categories");
                  setInlineLinkQuery("");
                } finally {
                  setInlineSaving(false);
                }
              }}
              onDelete={() => onDeleteNode(node.nodeKey)}
            />

            {shouldShowChildren ? (
              <div className={isExpanded || hasTreeSearch ? "nestedList nested-list treeChildren" : "nestedList nested-list treeChildren collapsed"}>
                <div className="treeChildrenInner">{renderBranch(node.nodeKey, depth + 1, renderTracker)}</div>
              </div>
            ) : null}
          </div>
        );
      })
      .filter((value): value is ReactElement => Boolean(value));

    if (parentKey) {
      const parent = nodeByKey.get(parentKey);
      const parentLabel = parent?.label || "parent";
      const addRowDepthStyle = { ["--tree-depth"]: String(depth) } as CSSProperties;
      renderedNodes.push(
        <div
          key={`add-${parentKey}`}
          className={`treeNode tree-item depth-${depth} has-parent is-last treeNodeAdd`}
          style={addRowDepthStyle}
        >
          {depth > 0 ? <span className="treeConnectorElbow" aria-hidden="true" /> : null}
          <div className="treeAddChild">
            <button type="button" className="treeAddChildBtn treeCard tree-card" onClick={() => onOpenAddEditor(parentKey)}>
              <span className="treeAddIcon" aria-hidden="true">
                <svg viewBox="0 0 20 20" width="18" height="18">
                  <path d="M10 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm1-11a1 1 0 1 0-2 0v2H7a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2h-2V7z" />
                </svg>
              </span>
              <span>Add menu item to {parentLabel}</span>
            </button>
          </div>
        </div>
      );
    }

    return renderedNodes;
  };

  const renderTracker = { count: 0, keys: [] as string[] };
  const renderedTree = renderBranch(null, 0, renderTracker);
  const isTreeRenderTruncated =
    renderTracker.count >= renderNodeLimit && visibleNodeKeys.length > renderTracker.count;

  return (
    <div className={`gemTreePanel${collapsed ? " collapsed" : ""}`}>
      <div className="treeSearchBar">
        <button
          type="button"
          className="treeCollapseBtn quickTreeTooltip"
          aria-label={collapsed ? "Expand tree menu" : "Collapse tree menu"}
          data-tooltip={collapsed ? "Expand tree menu" : "Collapse tree menu"}
          onClick={onToggleCollapse}
          disabled={saving}
        >
          <svg
            className={`treeCollapseBtnIcon${collapsed ? " collapsed" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M6 18L18 6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M12 6H18V12"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M6 12V18H12"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="treeRefreshBtn quickTreeTooltip"
          aria-label="refresh"
          data-tooltip="Refresh menu tree"
          onClick={onRefreshTree}
          disabled={saving}
        >
          ⟳
        </button>
        <button
          type="button"
          className="treeUndoBtn quickTreeTooltip"
          aria-label={undoEntries.length < 1 ? "Collapse tree cards" : "Undo history"}
          data-tooltip={undoEntries.length < 1 ? "Collapse tree cards" : "Undo history"}
          onClick={undoEntries.length < 1 ? onCollapseTreeCards : onUndoMenuToggle}
          disabled={saving}
        >
          ↶
        </button>
        <input
          className="treeSearchInput"
          value={treeSearch}
          onChange={(event) => onTreeSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onTreeSearchSubmit(treeSearch);
          }}
          placeholder="Search menu items..."
          aria-label="Search menu tree"
        />
        {undoMenuOpen ? (
          <div className="treeUndoMenu" role="menu" aria-label="Undo action history">
            {undoEntries.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                className="treeUndoOption"
                onClick={() => onUndoEntrySelect(entry.id)}
                role="menuitem"
              >
                <span className="treeUndoTask">Task {index + 1}</span>
                <span className="treeUndoTitle">{entry.title}</span>
              </button>
            ))}
            <div className="treeUndoMenuDivider" role="separator" />
            <button
              type="button"
              className="treeUndoOption treeUndoCollapseOption"
              onClick={() => { onUndoMenuToggle(); onCollapseTreeCards(); }}
              role="menuitem"
            >
              <span className="treeUndoTask">Menu</span>
              <span className="treeUndoTitle">Collapse tree cards</span>
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="treeSaveBtn quickTreeTooltip"
          aria-label={saving ? "Saving menu tree" : "Save menu tree"}
          data-tooltip={saving ? "Saving menu tree" : "Save menu tree"}
          onClick={() => void onSaveTree()}
          disabled={saving}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h7.8l2.7 2.7V13.5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-11zM4 2.7v3.6h6V2.7H4zm0 5v5.3h8V7.7H4z" />
          </svg>
        </button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragMove={onDragMove} onDragEnd={onDragEnd}>
        <SortableContext items={renderTracker.keys} strategy={verticalListSortingStrategy}>
          <div className="treeContent">
            <div id="root-menu" className="tree shopifyMenuTree nestedList nested-list rootList">
              {renderedTree}
              {isTreeRenderTruncated ? (
                <div className="treeRenderMore">
                  <button
                    type="button"
                    className="treeAddBtn treeCard tree-card"
                    onClick={() => setRenderNodeLimit((prev) => prev + TREE_RENDER_STEP)}
                  >
                    Load more menu items
                  </button>
                </div>
              ) : null}
              <div className="treeAddRoot treeNode tree-item">
                <button type="button" className="treeAddBtn treeCard tree-card" onClick={() => onOpenAddEditor(null)}>
                  <span className="treeAddIcon" aria-hidden="true">
                    <svg viewBox="0 0 20 20" width="18" height="18">
                      <path d="M10 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm1-11a1 1 0 1 0-2 0v2H7a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2h-2V7z" />
                    </svg>
                  </span>
                  <span>Add menu item</span>
                </button>
              </div>
            </div>
            <div className="unmappedWrap">
              <div className="unmappedDivider" />
              <div className="unmappedHead">
                <span>UNMAPPED COLLECTIONS</span>
                <span className="unmappedCount">{unmappedCollections.length}</span>
              </div>
              <div className="unmappedList">
                {unmappedCollections.length > 0 ? (
                  unmappedCollections.map((row) => {
                    const isEditingUnmapped = editingUnmappedCollectionId === row.id;
                    return (
                    <div
                      key={row.id}
                      role="button"
                      tabIndex={0}
                      className={[
                        "unmappedCard",
                        row.selected ? "selected" : "",
                        isEditingUnmapped ? "editing" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => {
                        if (isEditingUnmapped) return;
                        onToggleUnmappedCollection(row.id);
                      }}
                      onKeyDown={(event) => {
                        if (isEditingUnmapped) return;
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        onToggleUnmappedCollection(row.id);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!draggingUnmappedCollectionId || draggingUnmappedCollectionId === row.id) return;
                        onReorderUnmappedCollections(draggingUnmappedCollectionId, row.id);
                        setDraggingUnmappedCollectionId("");
                      }}
                      title={row.title}
                      aria-pressed={row.selected}
                    >
                      <span className="unmappedDragHandle" aria-hidden="true">
                        <button
                          type="button"
                          className="unmappedDragBtn"
                          draggable
                          disabled={isEditingUnmapped}
                          onClick={(event) => event.stopPropagation()}
                          onDragStart={(event) => {
                            event.stopPropagation();
                            setDraggingUnmappedCollectionId(row.id);
                          }}
                          onDragEnd={(event) => {
                            event.stopPropagation();
                            setDraggingUnmappedCollectionId("");
                          }}
                          aria-label={`Drag ${row.title}`}
                          title="Drag to reorder"
                        >
                          <svg viewBox="0 0 10 14" width="10" height="14">
                            <circle cx="2" cy="2" r="1.1" />
                            <circle cx="8" cy="2" r="1.1" />
                            <circle cx="2" cy="7" r="1.1" />
                            <circle cx="8" cy="7" r="1.1" />
                            <circle cx="2" cy="12" r="1.1" />
                            <circle cx="8" cy="12" r="1.1" />
                          </svg>
                        </button>
                      </span>
                      {isEditingUnmapped ? (
                        <input
                          className="unmappedInlineInput"
                          value={editingUnmappedTitle}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setEditingUnmappedTitle(event.target.value)}
                          onKeyDown={async (event) => {
                            event.stopPropagation();
                            if (event.key === "Escape") {
                              setEditingUnmappedCollectionId("");
                              setEditingUnmappedTitle("");
                              return;
                            }
                            if (event.key !== "Enter") return;
                            const nextTitle = editingUnmappedTitle.trim();
                            if (!nextTitle || savingUnmappedEdit) return;
                            setSavingUnmappedEdit(true);
                            try {
                              await onEditUnmappedCollection(row.id, nextTitle);
                              setEditingUnmappedCollectionId("");
                              setEditingUnmappedTitle("");
                            } finally {
                              setSavingUnmappedEdit(false);
                            }
                          }}
                          aria-label="Collection name"
                          autoFocus
                        />
                      ) : (
                        <span className="unmappedCardLabel">{row.title}</span>
                      )}
                      <span className="unmappedCardActions">
                        {isEditingUnmapped ? (
                          <button
                            type="button"
                            className="iconBtn success"
                            disabled={savingUnmappedEdit || !editingUnmappedTitle.trim()}
                            onClick={async (event) => {
                              event.stopPropagation();
                              const nextTitle = editingUnmappedTitle.trim();
                              if (!nextTitle || savingUnmappedEdit) return;
                              setSavingUnmappedEdit(true);
                              try {
                                await onEditUnmappedCollection(row.id, nextTitle);
                                setEditingUnmappedCollectionId("");
                                setEditingUnmappedTitle("");
                              } finally {
                                setSavingUnmappedEdit(false);
                              }
                            }}
                            aria-label="Save collection name"
                            title="Save"
                          >
                            <svg viewBox="0 0 20 20" width="14" height="14">
                              <path d="M7.8 13.8 4.5 10.5l1.4-1.4 1.9 1.9 6.3-6.3 1.4 1.4z" />
                            </svg>
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="iconBtn"
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditingUnmappedCollectionId(row.id);
                                setEditingUnmappedTitle(row.title);
                              }}
                              aria-label="Edit collection name"
                              title="Edit name"
                            >
                              <svg viewBox="0 0 20 20" width="14" height="14">
                                <path d="M14.69 2.86a1.5 1.5 0 0 1 2.12 2.12l-7.77 7.77-3.28.63.63-3.28 7.77-7.77zM4 15.5h12v1.5H4z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="iconBtn deleteBtn"
                              onClick={(event) => {
                                event.stopPropagation();
                                onDeleteUnmappedCollection(row.id);
                              }}
                              aria-label="Delete unmapped collection card"
                              title="Remove from unmapped list"
                            >
                              <svg viewBox="0 0 20 20" width="14" height="14">
                                <path d="M7.5 2.5h5l.7 1.5H17V6H3V4h3.8l.7-1.5zM5 7h10l-.8 10.5a1.5 1.5 0 0 1-1.5 1.3H7.3a1.5 1.5 0 0 1-1.5-1.3L5 7z" />
                              </svg>
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  )})
                ) : (
                  <div className="unmappedEmpty">No unmapped collections.</div>
                )}
              </div>
            </div>
          </div>
        </SortableContext>
      </DndContext>
      <style jsx>{`
        .gemTreePanel {
          padding: 12px;
          display: flex;
          flex-direction: column;
          min-height: 0;
          min-width: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          transform-origin: left top;
          transform: translate3d(0, 0, 0) scale(1);
          opacity: 1;
          will-change: padding, width, height, transform, opacity;
          transition:
            padding 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            width 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            height 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            transform 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            opacity 520ms ease;
        }
        .gemTreePanel.collapsed {
          padding: 12px 10px 0 12px;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: flex-start;
          justify-content: flex-start;
          transform: translate3d(0, 0, 0) scale(1);
        }
        .treeSearchBar {
          display: grid;
          grid-template-columns: 38px 38px 38px minmax(0, 1fr) 38px;
          gap: 8px;
          min-height: 38px;
          height: 38px;
          margin-bottom: 10px;
          align-items: center;
          position: sticky;
          top: 0;
          z-index: 8;
          background: linear-gradient(180deg, rgba(15, 26, 46, 0.98), rgba(15, 26, 46, 0.94));
          box-shadow: 0 1px 0 rgba(42, 58, 86, 0.9);
          transform-origin: left top;
          transform: translate3d(0, 0, 0);
          opacity: 1;
          transition:
            grid-template-columns 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            gap 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            width 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            margin 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            transform 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            opacity 520ms ease;
        }
        .treeSearchBar > .treeCollapseBtn,
        .treeSearchBar > .treeRefreshBtn,
        .treeSearchBar > .treeUndoBtn,
        .treeSearchBar > .treeSaveBtn,
        .treeSearchBar > .treeSearchInput {
          align-self: center;
          justify-self: center;
        }
        .treeSearchBar > .treeSearchInput {
          justify-self: stretch;
        }
        .treeCollapseBtn {
          width: 38px;
          height: 38px;
          min-width: 38px;
          min-height: 38px;
          padding: 0;
          border: 1px solid rgba(255, 255, 255, 0.5);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.14);
          color: rgba(255, 255, 255, 0.95);
          display: grid;
          place-items: center;
          line-height: 1;
          opacity: 1 !important;
          visibility: visible !important;
          position: relative;
          z-index: 5;
          -webkit-tap-highlight-color: transparent;
          transform: translate3d(0, 0, 0);
          transition:
            transform 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            border-color 140ms ease,
            background 140ms ease,
            color 140ms ease;
        }
        .treeCollapseBtn:hover {
          background: rgba(255, 255, 255, 0.14);
          border-color: rgba(255, 255, 255, 0.5);
          color: rgba(255, 255, 255, 0.95);
        }
        .treeCollapseBtn:focus,
        .treeCollapseBtn:focus-visible,
        .treeCollapseBtn:active {
          outline: none;
          box-shadow: none;
          background: rgba(255, 255, 255, 0.14);
          border-color: rgba(255, 255, 255, 0.5);
          color: rgba(255, 255, 255, 0.95);
        }
        .treeCollapseBtnIcon {
          width: 16px;
          height: 16px;
          display: block;
          transform: rotate(-90deg);
          transition: transform 1100ms cubic-bezier(0.22, 0.61, 0.36, 1);
        }
        .treeCollapseBtnIcon.collapsed {
          transform: rotate(0deg);
        }
        .gemTreePanel.collapsed .treeSearchBar {
          grid-template-columns: 38px 0 0 0 0;
          gap: 0;
          margin-bottom: 0;
          margin-top: 0;
          margin-left: 0;
          width: 38px;
          transform: translate3d(0, 0, 0);
        }
        .gemTreePanel.collapsed .treeRefreshBtn,
        .gemTreePanel.collapsed .treeUndoBtn,
        .gemTreePanel.collapsed .treeSearchInput,
        .gemTreePanel.collapsed .treeSaveBtn,
        .gemTreePanel.collapsed .treeContent,
        .gemTreePanel.collapsed .unmappedWrap {
          opacity: 0;
          pointer-events: none;
          overflow: hidden;
          transform: translate3d(-18px, -10px, 0) scale(0.94);
        }
        .treeRefreshBtn,
        .treeUndoBtn,
        .treeSearchInput,
        .treeSaveBtn,
        .treeContent,
        .unmappedWrap {
          transform-origin: left top;
          opacity: 1;
          transition:
            width 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            min-width 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            max-width 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            max-height 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            margin 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            padding 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            border-width 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            transform 1100ms cubic-bezier(0.22, 0.61, 0.36, 1),
            opacity 520ms ease;
          transform: translate3d(0, 0, 0) scale(1);
        }
        .treeRefreshBtn,
        .treeUndoBtn,
        .treeSaveBtn {
          max-width: 38px;
        }
        .quickTreeTooltip {
          position: relative;
        }
        .quickTreeTooltip[data-tooltip]::after {
          content: attr(data-tooltip);
          position: absolute;
          left: 50%;
          bottom: calc(100% + 6px);
          transform: translate(-50%, 2px);
          opacity: 0;
          pointer-events: none;
          white-space: nowrap;
          padding: 4px 7px;
          border-radius: 6px;
          border: 1px solid #5f789c;
          background: #0b1322;
          color: #e5edf9;
          font-size: 11px;
          font-weight: 700;
          line-height: 1;
          z-index: 200;
          transition: opacity 70ms ease, transform 70ms ease;
        }
        .quickTreeTooltip[data-tooltip]:hover::after,
        .quickTreeTooltip[data-tooltip]:focus-visible::after {
          opacity: 1;
          transform: translate(-50%, 0);
        }
        .treeSearchInput {
          width: 100%;
          max-width: 100%;
          min-height: 38px;
          height: 38px;
          align-self: center;
          font-size: 12px;
          font-weight: 600;
        }
        .treeSearchInput::placeholder {
          font-size: 12px;
          font-weight: 500;
        }
        .gemTreePanel.collapsed .treeContent,
        .gemTreePanel.collapsed .unmappedWrap {
          flex: 0 0 auto;
        }
        .gemTreePanel.collapsed .treeRefreshBtn,
        .gemTreePanel.collapsed .treeUndoBtn,
        .gemTreePanel.collapsed .treeSaveBtn {
          width: 0;
          min-width: 0;
          max-width: 0;
          padding: 0;
          border-width: 0;
        }
        .gemTreePanel.collapsed .treeSearchInput {
          width: 0;
          min-width: 0;
          max-width: 0;
          padding-left: 0;
          padding-right: 0;
          border-width: 0;
        }
        .treeSearchInput {
          min-width: 0;
        }
        .treeRefreshBtn {
          width: 38px;
          min-width: 38px;
          height: 38px;
          min-height: 38px;
          padding: 0;
          border: 1px solid #44556f;
          border-radius: 8px;
          background: #0f1a2e;
          color: #c7d3e4;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          line-height: 1;
        }
        .treeRefreshBtn:hover {
          background: #13233d;
          border-color: #5f789c;
        }
        .treeSaveBtn {
          width: 38px;
          min-width: 38px;
          height: 38px;
          min-height: 38px;
          border-radius: 8px;
          border: 1px solid #168e69;
          background: #0d7a57;
          color: #dffff1;
          padding: 0;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .treeSaveBtn svg {
          fill: currentColor;
        }
        .treeUndoBtn {
          width: 38px;
          min-width: 38px;
          height: 38px;
          min-height: 38px;
          border-radius: 8px;
          border: 1px solid #415a7a;
          background: #12233d;
          color: #dce8fb;
          padding: 0;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .treeUndoBtn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .treeUndoMenu {
          position: absolute;
          top: calc(100% + 4px);
          right: 50px;
          width: min(360px, 92vw);
          z-index: 40;
          border: 1px solid #344257;
          border-radius: 10px;
          background: #0a1324;
          box-shadow: 0 14px 30px rgba(0, 0, 0, 0.5);
          padding: 8px;
          display: grid;
          gap: 6px;
        }
        .treeUndoOption {
          min-height: 34px;
          border-radius: 8px;
          border: 1px solid #2a3547;
          background: #0f1a2e;
          color: #dbe7fa;
          text-align: left;
          display: grid;
          gap: 2px;
          padding: 6px 8px;
        }
        .treeUndoTask {
          font-size: 11px;
          color: #9fb3cf;
        }
        .treeUndoTitle {
          font-size: 12px;
          color: #e7efff;
          font-weight: 600;
        }
        .treeUndoEmpty {
          font-size: 12px;
          color: #9fb3cf;
          padding: 8px;
        }
        .treeUndoMenuDivider {
          height: 1px;
          background: #2a3547;
          margin: 4px 0;
        }
        .treeUndoCollapseOption .treeUndoTitle {
          color: #b8d4f3;
        }
        .treeUndoCollapseOption .treeUndoTask {
          color: #7090b4;
        }
        .treeContent {
          padding: 2px 2px 10px 2px;
          flex: 1 1 auto;
          min-height: 0;
          min-width: 0;
          width: 100%;
          height: 100%;
          max-height: 2000px;
          margin-top: 23px;
          overflow-y: auto;
          overflow-x: hidden;
          scrollbar-gutter: stable;
          scrollbar-width: none;
        }
        .treeContent::-webkit-scrollbar {
          width: 0;
          height: 0;
          display: none;
        }
        .unmappedWrap {
          margin-top: 12px;
          min-height: 0;
          min-width: 0;
          width: 100%;
          max-height: 600px;
          display: grid;
          gap: 8px;
          overflow-x: hidden;
        }
        .gemTreePanel.collapsed .treeContent {
          height: 0;
          max-height: 0;
          margin-top: 0;
          padding-top: 0;
          padding-bottom: 0;
        }
        .gemTreePanel.collapsed .unmappedWrap {
          max-height: 0;
          margin-top: 0;
        }
        .unmappedDivider {
          border-top: 1px solid #2a3547;
        }
        .unmappedHead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          color: #d6e3f4;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.05em;
        }
        .unmappedCount {
          border: 1px solid #3a4b61;
          border-radius: 8px;
          padding: 1px 7px;
          color: #aec3de;
          font-size: 11px;
          font-weight: 700;
        }
        .unmappedList {
          display: grid;
          gap: 6px;
          padding-right: 2px;
        }
        .unmappedCard {
          width: 100%;
          min-height: 38px;
          border-radius: 8px;
          border: 1px solid #315f92;
          background: linear-gradient(180deg, #10284b 0%, #0c1d39 100%);
          color: #e6f0ff;
          text-align: left;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          box-shadow: 0 1px 0 rgba(8, 17, 33, 0.25), 0 8px 18px rgba(2, 6, 23, 0.3);
        }
        .unmappedCard.editing {
          min-height: 38px;
          height: 38px;
        }
        .unmappedCard:hover {
          background: linear-gradient(180deg, #153765 0%, #112c55 100%);
          border-color: #5f9ed7;
        }
        .unmappedCard.selected {
          border-color: #7ec0ff;
          background: linear-gradient(180deg, #1c4f87 0%, #153f71 100%);
          box-shadow: inset 0 0 0 1px rgba(149, 202, 255, 0.45);
        }
        .unmappedDragHandle {
          color: #7a889f;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }
        .unmappedDragBtn {
          min-height: 0;
          width: 18px;
          height: 18px;
          border: 0;
          padding: 0;
          border-radius: 4px;
          background: transparent;
          color: inherit;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: grab;
        }
        .unmappedDragBtn:active {
          cursor: grabbing;
        }
        .unmappedDragBtn:hover {
          background: rgba(148, 163, 184, 0.14);
        }
        .unmappedDragHandle svg circle {
          fill: currentColor;
        }
        .unmappedCardLabel {
          min-width: 0;
          flex: 1 1 auto;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: 12px;
          font-weight: 600;
        }
        .unmappedInlineInput {
          min-height: 24px !important;
          height: 24px !important;
          width: 100%;
          min-width: 0;
          border-radius: 6px !important;
          border: 1px solid #3f587a !important;
          background: #0d1a2f !important;
          color: #e6edf7 !important;
          padding: 0 8px !important;
          font-size: 12px !important;
          font-weight: 500 !important;
          line-height: 1 !important;
          margin: 0 !important;
          flex: 1 1 auto;
        }
        .unmappedCardActions {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-left: auto;
          flex: 0 0 auto;
        }
        .unmappedEmpty {
          color: #8fa6c4;
          font-size: 12px;
          padding: 8px 2px;
        }
        .tree {
          overflow: visible;
        }
        .nestedList,
        .nested-list {
          margin-left: 0;
          padding-top: 0;
          min-height: 10px;
          display: block;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .nestedList.rootList,
        .nested-list.root-list {
          margin-left: 0;
          padding-top: 0;
        }
        :global(.treeNode) {
          --indent-step: 36px;
          --connector-stem-left: -22px;
          --connector-elbow-width: 22px;
          --connector-node-top: -8px;
          --connector-mid-y: 21px;
          position: relative;
          width: 100%;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
          padding-left: calc(var(--tree-depth, 0) * var(--indent-step));
          padding-bottom: 8px;
        }
        :global(.treeNode.depth-2),
        :global(.treeNode.depth-3) {
          --connector-stem-left: -57px;
          --connector-elbow-width: 57px;
        }
        :global(.treeNode.has-parent.editing-node) {
          --connector-mid-y: 49px;
        }
        :global(.treeConnectorElbow) {
          position: absolute;
          left: calc((var(--tree-depth, 0) * var(--indent-step)) + var(--connector-stem-left));
          top: var(--connector-node-top);
          width: var(--connector-elbow-width);
          height: calc(var(--connector-mid-y) - var(--connector-node-top) + 1px);
          border-left: 1px solid #8aa2c4;
          border-bottom: 1px solid #8aa2c4;
          z-index: 1;
          pointer-events: none;
        }
        :global(.treeConnectorVertical) {
          position: absolute;
          left: calc((var(--tree-depth, 0) * var(--indent-step)) + var(--connector-stem-left));
          top: calc(var(--connector-mid-y) - 1px);
          bottom: -8px;
          border-left: 1px solid #8aa2c4;
          z-index: 1;
          pointer-events: none;
        }
        :global(.treeRow) {
          position: relative;
          z-index: 10;
          width: 100%;
          box-sizing: border-box;
          background: linear-gradient(180deg, #10284b 0%, #0c1d39 100%);
          border: 1px solid #315f92;
          border-right: 1px solid #315f92 !important;
          border-radius: 8px;
          min-height: 42px;
          padding: 0 10px;
          display: flex;
          align-items: center;
          gap: 10px;
          box-shadow: 0 1px 0 rgba(8, 17, 33, 0.25), 0 8px 18px rgba(2, 6, 23, 0.3);
        }
        :global(.treeRow.editing) {
          min-height: 100px;
          align-items: flex-start;
          padding-top: 8px;
          padding-bottom: 8px;
          padding-right: 10px;
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          z-index: 2000;
        }
        :global(.treeRow.editing .dragHandle),
        :global(.treeRow.editing .treeToggle),
        :global(.treeRow.editing .treeToggleSpacer) {
          display: none;
        }
        :global(.treeText) {
          min-width: 0;
          flex: 1 1 auto;
          display: grid;
          gap: 2px;
          align-items: center;
          padding-top: 2px;
        }
        :global(.treeRow.editing .treeText) {
          width: 100%;
          min-width: 0;
          padding-top: 0;
        }
        :global(.treeLabel) {
          color: #f0f7ff;
          font-size: 13px;
          font-weight: 600;
          line-height: 1.15;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        :global(.treeTargetLabel) {
          color: #b8d4f3;
          font-size: 11px;
          line-height: 1.1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        :global(.treeTextEditing) {
          flex: 1 1 auto;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 8px;
          width: 100%;
          min-width: 0;
        }
        :global(.treeRow.editing .treeTextEditing) {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
          column-gap: 4px !important;
          align-items: start !important;
          justify-content: stretch !important;
          width: 100% !important;
          min-width: 0 !important;
        }
        :global(.treeInlineField) {
          flex: 1 1 0;
          min-width: 0;
          width: auto;
          max-width: none;
          display: grid;
          gap: 2px;
        }
        :global(.treeRow.editing .treeInlineField) {
          width: 100% !important;
          min-width: 0 !important;
          max-width: none !important;
          margin-top: 22px;
        }
        :global(.treeInlineLinkPickerWrap) {
          position: relative;
          width: 100%;
          z-index: 2200;
        }
        :global(.treeInlineInputLinkTrigger) {
          cursor: pointer;
        }
        :global(.treeInlineLinkPicker) {
          z-index: 5000;
          border: 1px solid #44556f;
          border-radius: 8px;
          background: #0b1220;
          box-shadow: 0 10px 24px rgba(2, 6, 23, 0.5);
          padding: 8px;
          display: grid;
          gap: 6px;
          font-family: inherit;
        }
        :global(.treeInlineLinkTypes) {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 4px;
        }
        :global(.treeInlineLinkCategories) {
          display: grid;
          gap: 2px;
        }
        :global(.treeInlineLinkCategoryOption) {
          min-height: 30px;
          border: 1px solid #2f415d;
          border-radius: 6px;
          background: #0a1324;
          color: #d7e2f1;
          font-size: 12px;
          font-weight: 600;
          font-family: inherit;
          padding: 0 8px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        :global(.treeInlineLinkCategoryOption:hover) {
          background: #13233d;
          border-color: #5f789c;
        }
        :global(.treeInlineLinkResultsHead) {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        :global(.treeInlineLinkBackBtn) {
          min-height: 24px;
          border: 1px solid #44556f;
          border-radius: 6px;
          background: #0a1324;
          color: #c7d3e4;
          padding: 0 8px;
          font-size: 12px;
          font-weight: 600;
          font-family: inherit;
        }
        :global(.treeInlineLinkResultsCount) {
          color: #9fb4d1;
          font-size: 12px;
          font-weight: 600;
          font-family: inherit;
        }
        :global(.treeInlineLinkTypeBtn) {
          min-height: 24px;
          border: 1px solid #44556f;
          border-radius: 6px;
          background: #0a1324;
          color: #c7d3e4;
          font-size: 12px;
          font-weight: 600;
          font-family: inherit;
          padding: 0 6px;
        }
        :global(.treeInlineLinkTypeBtn.active) {
          border-color: #87a8da;
          background: #13233d;
          color: #e6edf7;
        }
        :global(.treeInlineLinkSearch) {
          width: 100%;
          min-height: 24px;
          height: 24px;
          border: 1px solid #44556f;
          border-radius: 6px;
          background: #0a1324;
          color: #e6edf7;
          padding: 0 7px;
          box-sizing: border-box;
          font-size: 12px;
          font-weight: 600;
          line-height: 1.2;
          font-family: inherit;
        }
        :global(.treeInlineLinkPickerPortal .treeInlineLinkSearch) {
          min-height: 24px !important;
          height: 24px !important;
          max-height: 24px !important;
          padding: 0 7px !important;
          font-size: 12px !important;
          font-weight: 600 !important;
          line-height: 24px !important;
          font-family: inherit !important;
        }
        :global(.treeInlineLinkOptions) {
          max-height: 180px;
          overflow: auto;
          display: grid;
          gap: 4px;
        }
        :global(.treeInlineLinkOption) {
          text-align: left;
          border: 1px solid #2f415d;
          border-radius: 6px;
          background: #0a1324;
          color: #d7e2f1;
          min-height: 28px;
          padding: 0 8px;
          font-size: 12px;
          font-weight: 600;
          font-family: inherit;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        :global(.treeInlineLinkOption:hover) {
          background: #13233d;
          border-color: #5f789c;
        }
        :global(.treeInlineLinkEmpty) {
          color: #8fa6c4;
          font-size: 12px;
          font-family: inherit;
          padding: 6px 2px;
        }
        :global(.treeInlineLinkFooter) {
          display: flex;
          justify-content: flex-end;
        }
        :global(.treeInlineLinkCloseBtn) {
          min-height: 24px;
          border: 1px solid #44556f;
          border-radius: 6px;
          background: #0a1324;
          color: #c7d3e4;
          padding: 0 8px;
          font-size: 12px;
          font-weight: 600;
          font-family: inherit;
        }
        :global(.treeInlineFieldLabel) {
          color: #b6c7df;
          font-size: 9px;
          font-weight: 600;
          line-height: 0.95;
          margin: 0;
          display: block;
          text-align: left;
          padding-left: 0;
        }
        :global(.treeInlineInput) {
          width: 100%;
          min-width: 0;
          height: 10px;
          min-height: 10px;
          border-radius: 7px;
          border: 1px solid #5f789c;
          background: #0a1324;
          color: #e6edf7;
          padding: 0 6px;
          font-size: 13px;
          font-weight: 600;
          line-height: normal;
          box-sizing: border-box;
        }
        :global(.treeInlineInput:focus) {
          outline: none;
          border-color: #87a8da;
          box-shadow: 0 0 0 1px rgba(135, 168, 218, 0.32);
        }
        :global(.treeRow.editing .treeInlineInput) {
          margin-top: 4px;
          width: 100% !important;
          min-width: 0 !important;
        }
        :global(.treeRow:hover) {
          background: linear-gradient(180deg, #153765 0%, #112c55 100%);
          border-color: #5f9ed7;
        }
        :global(.treeRow.active) {
          border-color: #7ec0ff;
          background: linear-gradient(180deg, #1c4f87 0%, #153f71 100%);
          box-shadow: inset 0 0 0 1px rgba(149, 202, 255, 0.45);
        }
        :global(.treeRow.hidden-node) {
          opacity: 0.72;
        }
        :global(.treeRow.dragging) {
          opacity: 0.45;
        }
        :global(.treeRow.drop-before) {
          border-top-color: #38bdf8;
          box-shadow: inset 0 2px 0 #38bdf8;
        }
        :global(.treeRow.drop-after) {
          border-bottom-color: #38bdf8;
          box-shadow: inset 0 -2px 0 #38bdf8;
        }
        :global(.treeRow.drop-inside) {
          background: rgba(56, 189, 248, 0.08);
          box-shadow: inset 0 0 0 1px #38bdf8;
        }
        :global(.treeChildren) {
          display: grid;
          grid-template-rows: 1fr;
          margin-top: 8px;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          transition:
            grid-template-rows 180ms ease,
            opacity 180ms ease;
          opacity: 1;
        }
        :global(.treeChildrenInner) {
          min-height: 0;
          overflow: visible;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        :global(.treeChildren.collapsed) {
          grid-template-rows: 0fr;
          margin-top: 0;
          opacity: 1;
        }
        :global(.treeChildren.collapsed .treeChildrenInner) {
          overflow: hidden;
        }
        :global(.treeToggle svg.collapsed) {
          transform: rotate(-90deg);
        }
        :global(.treeToggle svg) {
          transition: transform 0.2s ease;
        }
        :global(.treeToggle) {
          width: 18px;
          height: 18px;
          min-height: 18px;
          border: 0;
          padding: 0;
          background: transparent;
          color: #b8d7f8;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        :global(.treeToggle svg path) {
          fill: currentColor;
        }
        :global(.treeToggleSpacer) {
          width: 18px;
          height: 18px;
          flex: 0 0 auto;
        }
        :global(.dragHandle) {
          color: #9bc0e8;
          cursor: grab;
        }
        :global(.dragHandle svg circle) {
          fill: currentColor;
        }
        :global(.treeRowActions) {
          margin-left: auto;
          display: inline-flex;
          gap: 8px;
          opacity: 1;
        }
        :global(.treeRow.editing .treeRowActions) {
          position: absolute;
          top: 8px;
          right: 10px;
          margin-left: 0;
          gap: 3px;
          flex: 0 0 auto;
        }
        :global(.treeRow.editing .iconBtn) {
          width: 20px;
          height: 20px;
          min-height: 20px;
        }
        :global(.iconBtn) {
          width: 24px;
          height: 24px;
          min-height: 24px;
          padding: 0;
          border: 1px solid #4d78a8;
          border-radius: 8px;
          background: #112a4c;
          color: #d6e7fb;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        :global(.iconBtn svg path) {
          fill: currentColor;
        }
        :global(.iconBtn:hover) {
          border-color: #74afdf;
          background: #19406f;
        }
        :global(.iconBtn.success) {
          border-color: #168e69;
          color: #9ff0d5;
        }
        :global(.iconBtn.success:hover) {
          border-color: #1db783;
          background: #11372d;
        }
        :global(.iconBtn.danger) {
          border-color: #7f2d2d;
          color: #fca5a5;
          background: #2a1518;
        }
        :global(.iconBtn.danger:hover) {
          border-color: #c53030;
          color: #ffb4b4;
          background: #3d1a1e;
        }
        :global(.iconBtn.eye-active:hover) {
          border-color: #c53030;
          color: #ffb4b4;
          background: #3d1a1e;
        }
        :global(.iconBtn.deleteBtn:hover),
        :global(.iconBtn.deleteBtn:active) {
          border-color: #c53030;
          color: #ffb4b4;
          background: #3d1a1e;
        }
        :global(.treeAddRoot) {
          margin-top: 0;
          padding: 0;
        }
        :global(.treeAddChild) {
          padding: 0;
          margin-left: 0;
        }
        :global(.treeCard) {
          width: 100%;
          box-sizing: border-box;
          border-right: 1px solid #315f92 !important;
        }
        :global(.treeAddBtn),
        :global(.treeAddChildBtn) {
          width: 100%;
          min-height: 42px;
          border-radius: 8px;
          border: 1px solid #315f92;
          background: linear-gradient(180deg, #10284b 0%, #0c1d39 100%);
          color: #b8d7f8;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          justify-content: flex-start;
          padding: 0 10px;
          font-size: 13px;
          box-shadow: 0 1px 0 rgba(8, 17, 33, 0.25), 0 8px 18px rgba(2, 6, 23, 0.3);
        }
        :global(.treeAddBtn:hover),
        :global(.treeAddChildBtn:hover) {
          background: linear-gradient(180deg, #153765 0%, #112c55 100%);
          border-color: #5f9ed7;
        }
        :global(.treeAddIcon) {
          width: 20px;
          height: 20px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #a6cdff;
          line-height: 1;
        }
        :global(.treeAddIcon svg) {
          fill: currentColor;
        }
        :global(.treeAddBtn span:last-child),
        :global(.treeAddChildBtn span:last-child) {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        @media (max-width: 980px) {
          .treeSearchBar {
            grid-template-columns: 36px 36px minmax(0, 1fr) 36px;
          }
        }
      `}</style>
    </div>
  );
}
