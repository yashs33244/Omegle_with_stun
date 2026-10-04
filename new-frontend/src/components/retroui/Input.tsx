import React, { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ type = "text", placeholder = "Enter text", className = "", ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        placeholder={placeholder}
        className={`px-4 py-2 w-full border-2 shadow-md transition focus:outline-hidden focus:shadow-xs ${
          props["aria-invalid"]
            ? "border-red-500 text-red-500 shadow-xs shadow-red-600"
            : ""
        } ${className}`}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
