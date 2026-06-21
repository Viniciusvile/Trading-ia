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
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Exibido na barra inferior mobile */
  mobile?: boolean;
  /** Descri????o curta para tooltip/onboarding */
  description?: string;
}

export const navItems: NavItem[] = [
  {
    href: "/",
    label: "In??cio",
    icon: Home,
    mobile: true,
    description: "Vis??o geral da sua conta e bots",
  },
  {
    href: "/mercado",
    label: "Mercado",
    icon: LineChart,
    mobile: true,
    description: "Cota????es, gr??ficos e an??lise t??cnica",
  },
  {
    href: "/bots",
    label: "Bots",
    icon: Bot,
    mobile: true,
    description: "Controle dos rob??s de opera????o",
  },
  {
    href: "/posicoes",
    label: "Posi????es",
    icon: Wallet,
    description: "Opera????es abertas e hist??rico",
  },
  {
    href: "/estrategias",
    label: "Estrat??gias",
    icon: Brain,
    description: "Backtests e configura????es de estrat??gia",
  },
  {
    href: "/diario",
    label: "Di??rio",
    icon: BookOpen,
    mobile: true,
    description: "Anota????es e aprendizados de cada opera????o",
  },
  {
    href: "/alertas",
    label: "Alertas",
    icon: Bell,
    description: "Avisos de pre??o e eventos",
  },
  {
    href: "/replay",
    label: "Replay",
    icon: History,
    description: "Treine operando em modo replay hist??rico",
  },
  {
    href: "/status",
    label: "Status",
    icon: Activity,
    description: "Sa??de dos servi??os do sistema",
  },

  {
    href: "/ajustes",
    label: "Ajustes",
    icon: Settings,
    mobile: true,
    description: "Prefer??ncias, tema e seguran??a",
  },
];

export const mobileNavItems = navItems.filter((i) => i.mobile);

