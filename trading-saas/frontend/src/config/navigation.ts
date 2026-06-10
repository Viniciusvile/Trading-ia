import {
  Home,
  LineChart,
  Bot,
  BookOpen,
  Settings,
  Bell,
  Wallet,
  Brain,
  History,
  Activity,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Exibido na barra inferior mobile */
  mobile?: boolean;
  /** Descrição curta para tooltip/onboarding */
  description?: string;
}

export const navItems: NavItem[] = [
  {
    href: "/",
    label: "Início",
    icon: Home,
    mobile: true,
    description: "Visão geral da sua conta e bots",
  },
  {
    href: "/mercado",
    label: "Mercado",
    icon: LineChart,
    mobile: true,
    description: "Cotações, gráficos e análise técnica",
  },
  {
    href: "/bots",
    label: "Bots",
    icon: Bot,
    mobile: true,
    description: "Controle dos robôs de operação",
  },
  {
    href: "/posicoes",
    label: "Posições",
    icon: Wallet,
    description: "Operações abertas e histórico",
  },
  {
    href: "/estrategias",
    label: "Estratégias",
    icon: Brain,
    description: "Backtests e configurações de estratégia",
  },
  {
    href: "/diario",
    label: "Diário",
    icon: BookOpen,
    mobile: true,
    description: "Anotações e aprendizados de cada operação",
  },
  {
    href: "/alertas",
    label: "Alertas",
    icon: Bell,
    description: "Avisos de preço e eventos",
  },
  {
    href: "/replay",
    label: "Replay",
    icon: History,
    description: "Treine operando em modo replay histórico",
  },
  {
    href: "/status",
    label: "Status",
    icon: Activity,
    description: "Saúde dos serviços do sistema",
  },
  {
    href: "/ajustes",
    label: "Ajustes",
    icon: Settings,
    mobile: true,
    description: "Preferências, tema e segurança",
  },
];

export const mobileNavItems = navItems.filter((i) => i.mobile);
