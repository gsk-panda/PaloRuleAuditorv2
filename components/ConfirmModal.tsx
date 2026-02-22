import React from 'react';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) => {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div className="relative w-full max-w-md mx-4 bg-[#111827] border border-[#1e2d3d] rounded shadow-2xl font-mono">
        {/* Header */}
        <div className={`px-6 py-4 border-b border-[#1e2d3d] flex items-center gap-3 ${danger ? 'text-red-400' : 'text-amber-400'}`}>
          <span className="text-lg">{danger ? '⚠' : '?'}</span>
          <h3 className="text-sm font-bold uppercase tracking-widest">{title}</h3>
        </div>
        {/* Body */}
        <div className="px-6 py-5">
          <p className="text-sm text-slate-300 leading-relaxed">{message}</p>
        </div>
        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#1e2d3d] flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 bg-[#1e2d3d] hover:bg-[#243348] border border-[#2d3d50] rounded transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-bold rounded transition-colors ${
              danger
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-amber-500 hover:bg-amber-600 text-black'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
