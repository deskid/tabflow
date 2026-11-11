import React from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Trash2 } from 'lucide-react';
import { FaviconImage } from './FaviconImage';

interface BookmarksViewProps {
  bookmarkTree: chrome.bookmarks.BookmarkTreeNode[];
  searchQuery: string;
  searchResults: chrome.bookmarks.BookmarkTreeNode[];
  expandedFolderIds: Set<string>;
  onToggleFolder: (folderId: string) => void;
  onOpenBookmark: (url: string, newTab?: boolean) => void;
  onDeleteBookmark: (id: string) => void;
}

export const BookmarksView: React.FC<BookmarksViewProps> = ({
  bookmarkTree,
  searchQuery,
  searchResults,
  expandedFolderIds,
  onToggleFolder,
  onOpenBookmark,
  onDeleteBookmark,
}) => {
  if (searchQuery.trim()) {
    if (searchResults.length === 0) {
      return (
        <div className="p-6 text-center text-[12px] text-[var(--text-medium)]">
          未找到匹配书签
        </div>
      );
    }
    return (
      <div className="p-1 space-y-0.5">
        {searchResults.map((item) => (
          <div
            key={item.id}
            onClick={() => item.url && onOpenBookmark(item.url)}
            className="group flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-[var(--surface-hover)] cursor-pointer text-[13px] text-[var(--text-high)] transition-colors duration-150 ease-out"
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <FaviconImage url={item.url} size={15} />
              <span className="truncate">{item.title || item.url}</span>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteBookmark(item.id);
              }}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-[var(--text-medium)] hover:text-[var(--danger-text)] transition-opacity duration-150 ease-out"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    );
  }

  const renderNodes = (nodes: chrome.bookmarks.BookmarkTreeNode[], depth = 0): React.ReactNode => {
    return nodes.map((node) => {
      const isFolder = !node.url;
      const isExpanded = expandedFolderIds.has(node.id);

      if (isFolder) {
        if (node.id === '0') {
          return node.children ? renderNodes(node.children, depth) : null;
        }

        return (
          <div key={node.id} className="select-none">
            <div
              onClick={() => onToggleFolder(node.id)}
              style={{ paddingLeft: `${depth * 10 + 6}px` }}
              className="flex items-center gap-1.5 py-1 pr-1.5 rounded-md hover:bg-[var(--surface-hover)] cursor-pointer text-[12px] font-medium text-[var(--text-high)] transition-colors duration-150 ease-out"
            >
              <span className="text-[var(--text-medium)] flex items-center shrink-0">
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <span className="text-[var(--amber-9)] flex items-center shrink-0">
                {isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />}
              </span>
              <span className="truncate flex-1">{node.title || '书签文件夹'}</span>
              {node.children && (
                <span className="text-[12px] text-[var(--text-medium)] font-normal shrink-0">
                  ({node.children.length})
                </span>
              )}
            </div>

            {isExpanded && node.children && (
              <div>{renderNodes(node.children, depth + 1)}</div>
            )}
          </div>
        );
      }

      return (
        <div
          key={node.id}
          onClick={() => node.url && onOpenBookmark(node.url)}
          style={{ paddingLeft: `${depth * 10 + 18}px` }}
          className="group flex items-center justify-between py-1 pr-1.5 rounded-md hover:bg-[var(--surface-hover)] cursor-pointer text-[13px] text-[var(--text-medium)] hover:text-[var(--text-high)] transition-colors duration-150 ease-out"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <FaviconImage url={node.url} size={14} />
            <span className="truncate">{node.title || node.url}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteBookmark(node.id);
            }}
            title="删除"
            className="opacity-0 group-hover:opacity-100 p-0.5 text-[var(--text-medium)] hover:text-[var(--danger-text)] transition-opacity duration-150 ease-out"
          >
            <Trash2 size={12} />
          </button>
        </div>
      );
    });
  };

  return <div className="p-1 space-y-0.5">{renderNodes(bookmarkTree)}</div>;
};
