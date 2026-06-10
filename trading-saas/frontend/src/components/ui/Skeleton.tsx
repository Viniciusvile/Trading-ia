import { type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: string | number;
  height?: string | number;
  circle?: boolean;
}

export function Skeleton({ width, height, circle, className, style, ...rest }: SkeletonProps) {
  return (
    <div
      className={cn("skeleton", circle && "rounded-full", className)}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}
