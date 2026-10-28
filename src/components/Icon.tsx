export type IconName = "home" | "upload" | "review" | "reports" | "file" | "shield" | "users";

export function Icon({ name }: { name: IconName }) {
  const paths = {
    home: <path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10.5Z" />,
    upload: <path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v6h14v-6" />,
    review: <path d="M8 4h8m-9 3h10a2 2 0 0 1 2 2v11H5V9a2 2 0 0 1 2-2Zm2-3h6v5H9V4Zm0 9h6m-6 4h4" />,
    reports: <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />,
    file: <path d="M7 2h7l5 5v15H7V2Zm7 0v6h5M10 13h6m-6 4h6" />,
    users: <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10v-1a6 6 0 0 1 12 0v1m2-10a3 3 0 1 0 0-6m6 16v-1a5 5 0 0 0-4-4.9" />,
    shield: <path d="M12 2 4.5 5v6c0 5 3.2 8.6 7.5 11 4.3-2.4 7.5-6 7.5-11V5L12 2Zm-3 10 2 2 4-5" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
