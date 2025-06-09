import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  placeholder?: string;
  className?: string;
}

interface SelectItemProps {
  value: string;
  children: React.ReactNode;
  onSelect?: () => void;
}

const Select = React.forwardRef<HTMLDivElement, SelectProps>(
  ({ value, onValueChange, children, placeholder, className }, ref) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [selectedLabel, setSelectedLabel] = React.useState<string>("");
    const [dropdownPosition, setDropdownPosition] = React.useState<
      "bottom" | "top"
    >("bottom");
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
      // Find the selected item's label from children
      React.Children.forEach(children, (child) => {
        if (React.isValidElement(child) && child.props.value === value) {
          setSelectedLabel(child.props.children);
        }
      });
    }, [value, children]);

    const handleToggle = () => {
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
      <div ref={containerRef} className={cn("relative", className)}>
        <button
          type="button"
          onClick={handleToggle}
          className="flex h-10 w-full items-center justify-between rounded-md border-2 border-black bg-white px-3 py-2 text-sm shadow-sm transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
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
            <div className="max-h-60 overflow-auto p-1">
              {React.Children.map(children, (child) => {
                if (React.isValidElement(child)) {
                  return React.cloneElement(child, {
                    onSelect: () => {
                      onValueChange(child.props.value);
                      setIsOpen(false);
                    },
                  } as any);
                }
                return child;
              })}
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
  ({ value, children, onSelect }, ref) => {
    return (
      <div
        ref={ref}
        onClick={onSelect}
        className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm text-black hover:bg-gray-100 hover:text-black focus:bg-gray-100 focus:text-black"
      >
        {children}
      </div>
    );
  }
);
SelectItem.displayName = "SelectItem";

export { Select, SelectItem };
