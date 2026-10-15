// The bottom navigation of the app's pages (home, map, memories, account): <nav class="tabbar" data-current="home">
const TABS = [
  { id: 'home', href: 'home.html', label: 'الرئيسية',
    icon: '<path d="M4 11l8-6.5 8 6.5V20h-5.5v-5h-5v5H4z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>' },
  { id: 'map', href: 'map.html', label: 'الخريطة',
    icon: '<path d="M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z M9 4.5v13 M15 6.5v13" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/>' },
  { id: 'memories', href: 'memories.html', label: 'الذكريات',
    icon: '<rect x="3.5" y="5" width="17" height="14" rx="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M3.5 15l4.5-4 4 3.5 3-2.5 5 4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>' },
  { id: 'account', href: 'account.html', label: 'الحساب',
    icon: '<circle cx="12" cy="8.5" r="3.8" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M4.5 20c1.3-3.6 4.2-5.5 7.5-5.5s6.2 1.9 7.5 5.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>' },
];

for (const nav of document.querySelectorAll('nav.tabbar')) {
  nav.setAttribute('aria-label', 'التنقل');
  const ul = document.createElement('ul');
  for (const t of TABS) {
    const li = document.createElement('li');
    const current = nav.dataset.current === t.id;
    li.innerHTML = `<a href="${t.href}"${current ? ' aria-current="page"' : ''}><span class="pip"><svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg></span>${t.label}</a>`;
    ul.appendChild(li);
  }
  nav.replaceChildren(ul);
}
