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

type FocusTarget = "selected" | "first" | "last";

const optionElements = (container: HTMLElement | null): HTMLElement[] =>
  Array.from(container?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

/**
 * Usage: <Select value onValueChange><SelectItem value="x">Label</SelectItem>...</Select>.
 * There is no `options` prop; render one SelectItem per option.
 *
 * Keyboard: Enter, Space or the arrow keys open the list and focus the
 * selected option; arrows, Home and End move; Enter or Space picks; Escape
 * closes and returns focus to the trigger; Tab closes and moves on.
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
    const [focusTarget, setFocusTarget] = React.useState<FocusTarget | null>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const listId = React.useId();
    React.useImperativeHandle(ref, () => containerRef.current as HTMLDivElement);

    const items = React.Children.toArray(children).filter(
      (child): child is React.ReactElement<SelectItemProps> =>
        React.isValidElement<SelectItemProps>(child)
    );
    const selectedLabel = items.find((child) => child.props.value === value)
      ?.props.children;

    // Move focus into the list once it has rendered.
    React.useEffect(() => {
      if (!isOpen || !focusTarget) return;
      const options = optionElements(containerRef.current);
      const selectedIndex = options.findIndex(
        (o) => o.getAttribute("aria-selected") === "true"
      );
      const index =
        focusTarget === "first"
          ? 0
          : focusTarget === "last"
            ? options.length - 1
            : Math.max(0, selectedIndex);
      options[index]?.focus();
      setFocusTarget(null);
    }, [isOpen, focusTarget]);

    const open = (target: FocusTarget) => {
      if (disabled) return;
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        // Not enough room below (less than 200px) and more above: render upward.
        setDropdownPosition(
          spaceBelow < 200 && spaceAbove > spaceBelow ? "top" : "bottom"
        );
      }
      setIsOpen(true);
      setFocusTarget(target);
    };

    const close = (restoreFocus: boolean) => {
      setIsOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    };

    const moveFocus = (step: number | "first" | "last") => {
      const options = optionElements(containerRef.current);
      if (options.length === 0) return;
      const current = options.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (step === "first") next = 0;
      else if (step === "last") next = options.length - 1;
      else next = Math.min(options.length - 1, Math.max(0, current + step));
      options[next]?.focus();
    };

    const onContainerKeyDown = (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          close(true);
          break;
        case "ArrowDown":
          e.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveFocus(-1);
          break;
        case "Home":
          e.preventDefault();
          moveFocus("first");
          break;
        case "End":
          e.preventDefault();
          moveFocus("last");
          break;
        case "Tab":
          close(false);
          break;
      }
    };

    const onTriggerKeyDown = (e: React.KeyboardEvent) => {
      if (isOpen) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        open("selected");
      }
    };

    return (
      <div
        ref={containerRef}
        className={cn("relative", className)}
        onKeyDown={onContainerKeyDown}
      >
        <button
          ref={triggerRef}
          type="button"
          id={id}
          onClick={() => (isOpen ? close(false) : open("selected"))}
          onKeyDown={onTriggerKeyDown}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-label={ariaLabel}
          data-testid={testId}
          className="flex h-10 w-full items-center justify-between rounded-md border-2 border-black bg-white px-3 py-2 text-sm shadow-sm transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={cn("truncate", selectedLabel ? "text-black" : "text-gray-500")}>
            {selectedLabel || placeholder}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-4 w-4 shrink-0 text-black transition-transform",
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
            <div
              id={listId}
              className="max-h-60 overflow-auto p-1"
              role="listbox"
              aria-label={ariaLabel}
            >
              {items.map((child) =>
                React.cloneElement(child, {
                  selected: child.props.value === value,
                  onSelect: () => {
                    onValueChange(child.props.value);
                    close(true);
                  },
                })
              )}
            </div>
          </div>
        )}

        {isOpen && (
          <div
            className="fixed inset-0 z-[9998]"
            aria-hidden="true"
            onClick={() => close(false)}
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
        tabIndex={-1}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.();
          }
        }}
        className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm text-black hover:bg-gray-100 hover:text-black focus:bg-gray-100 focus:text-black focus:outline-none"
      >
        {children}
      </div>
    );
  }
);
SelectItem.displayName = "SelectItem";

export { Select, SelectItem };
