import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

interface SelectItemProps {
  value: string;
  children: React.ReactNode;
  onSelect?: () => void;
  selected?: boolean;
}

/**
 * Usage: <Select value onValueChange><SelectItem value="x">Label</SelectItem>...</Select>.
 * There is no `options` prop; render one SelectItem per option.
 */
const Select = React.forwardRef<HTMLDivElement, SelectProps>(
  (
    {
      value,
      onValueChange,
      children,
      placeholder,
      className,
      disabled,
      id,
      "aria-label": ariaLabel,
      "data-testid": testId,
    },
    ref
  ) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [dropdownPosition, setDropdownPosition] = React.useState<
      "bottom" | "top"
    >("bottom");
    const containerRef = React.useRef<HTMLDivElement>(null);
    React.useImperativeHandle(ref, () => containerRef.current as HTMLDivElement);

    const items = React.Children.toArray(children).filter(
      (child): child is React.ReactElement<SelectItemProps> =>
        React.isValidElement<SelectItemProps>(child)
    );
    const selectedLabel = items.find((child) => child.props.value === value)
      ?.props.children;

    const handleToggle = () => {
      if (disabled) return;
      if (!isOpen && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        // If there's not enough space below (less than 200px) and more space above, render upward
        if (spaceBelow < 200 && spaceAbove > spaceBelow) {
          setDropdownPosition("top");
        } else {
          setDropdownPosition("bottom");
        }
      }
      setIsOpen(!isOpen);
    };

    return (
      <div
        ref={containerRef}
        className={cn("relative", className)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && isOpen) {
            e.preventDefault();
            e.stopPropagation();
            setIsOpen(false);
          }
        }}
      >
        <button
          type="button"
          id={id}
          onClick={handleToggle}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={ariaLabel}
          data-testid={testId}
          className="flex h-10 w-full items-center justify-between rounded-md border-2 border-black bg-white px-3 py-2 text-sm shadow-sm transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={selectedLabel ? "text-black" : "text-gray-500"}>
            {selectedLabel || placeholder}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-black transition-transform",
              isOpen && "rotate-180"
            )}
          />
        </button>

        {isOpen && (
          <div
            className={cn(
              "absolute z-[9999] w-full rounded-md border-2 border-black bg-white shadow-lg max-h-60 overflow-hidden",
              dropdownPosition === "bottom"
                ? "top-full mt-1"
                : "bottom-full mb-1"
            )}
          >
            <div className="max-h-60 overflow-auto p-1" role="listbox" aria-label={ariaLabel}>
              {items.map((child) =>
                React.cloneElement(child, {
                  selected: child.props.value === value,
                  onSelect: () => {
                    onValueChange(child.props.value);
                    setIsOpen(false);
                  },
                })
              )}
            </div>
          </div>
        )}

        {isOpen && (
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setIsOpen(false)}
          />
        )}
      </div>
    );
  }
);
Select.displayName = "Select";

const SelectItem = React.forwardRef<HTMLDivElement, SelectItemProps>(
  ({ children, onSelect, selected }, ref) => {
    return (
      <div
        ref={ref}
        role="option"
        aria-selected={selected ?? false}
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.();
          }
        }}
        className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm text-black hover:bg-gray-100 hover:text-black focus:bg-gray-100 focus:text-black"
      >
        {children}
      </div>
    );
  }
);
SelectItem.displayName = "SelectItem";

export { Select, SelectItem };
