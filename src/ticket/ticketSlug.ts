const maxLength = 50;

export const createTicketSlug = (title: string): string => {
  const words = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '');

  const slug = words.slice(0, maxLength).replace(/-$/, '');

  return slug === '' ? 'ticket' : slug;
};
