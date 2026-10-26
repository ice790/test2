const navToggle = document.getElementById("navToggle");
const navMenu = document.getElementById("navMenu");
const header = document.querySelector(".site-header");

function closeNav() {
  navMenu.classList.remove("open");
  navToggle.classList.remove("open");
  navToggle.setAttribute("aria-expanded", "false");
  navToggle.setAttribute("aria-label", "打开菜单");
}

navToggle.addEventListener("click", () => {
  const open = navMenu.classList.toggle("open");
  navToggle.classList.toggle("open", open);
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
});

navMenu.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", closeNav);
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 720) closeNav();
});

function updateHeader() {
  header.classList.toggle("scrolled", window.scrollY > 24);
}

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const revealElements = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  revealElements.forEach((el) => revealObserver.observe(el));
} else {
  revealElements.forEach((el) => el.classList.add("visible"));
}

const navLinks = Array.from(document.querySelectorAll(".nav-menu a"));
const sections = Array.from(document.querySelectorAll("main section[id]"));

if ("IntersectionObserver" in window) {
  const spyObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navLinks.forEach((link) => {
          link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`);
        });
      });
    },
    { rootMargin: "-42% 0px -52% 0px", threshold: 0 }
  );

  sections.forEach((section) => spyObserver.observe(section));
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!prefersReducedMotion) {
  const rain = document.getElementById("rain");
  const dropCount = window.innerWidth < 720 ? 10 : 22;

  for (let i = 0; i < dropCount; i += 1) {
    const drop = document.createElement("span");
    drop.className = "drop";
    drop.style.left = `${Math.random() * 100}%`;
    drop.style.height = `${48 + Math.random() * 74}px`;
    drop.style.opacity = (0.2 + Math.random() * 0.45).toFixed(2);
    drop.style.animationDuration = `${3.4 + Math.random() * 4.6}s`;
    drop.style.animationDelay = `${-Math.random() * 8}s`;
    rain.appendChild(drop);
  }
}

const modalData = {
  lost: {
    tag: "前两年",
    title: "浑浑噩噩的日子",
    body: [
      "那两年，我几乎是被时间推着走的。日子看起来照常运转，回头却发现能留下来的东西并不多。",
      "我不打算把这段经历美化成什么必经的弯路。荒废就是荒废，错过了就是错过了。承认这一点，反而让我轻松了一些。",
      "现在再想起那段时间，更多的是一种提醒：别再让自己后悔第二次。"
    ]
  },
  people: {
    tag: "相遇与告别",
    title: "很多人来过，很多人离开",
    body: [
      "我谈过恋爱，也失过恋；和曾经要好的朋友绝交；认识了很多人，也淡交了很多人。",
      "当时觉得天塌下来的事情，如今回头看，只是人生里的一个片段。但这些片段加在一起，改变了我看人、看事、看自己的方式。",
      "我开始明白，关系会变，人也会变。能留下的人值得珍惜，离开的人也不必强求。"
    ]
  },
  now: {
    tag: "九月 · 此刻",
    title: "重新开始",
    body: [
      "今年九月，我正式开始学习 Java SE 和 AI Agent。",
      "不是为了跟谁比较，只是不想再让时间空转。每天多一点积累，心里就踏实一点。",
      "也许将来的某日，我会为自己写下的这段话感到欣慰。"
    ]
  },
  java: {
    tag: "学习计划",
    title: "Java SE",
    body: [
      "目前从 Java SE 基础重新开始：语法、面向对象、集合、异常、IO，再往后补上多线程。",
      "先把手感练回来，能独立写出结构清晰的小程序，再往项目和框架方向走。",
      "不追求一下子学得多快，只希望每天都有实实在在的进步。"
    ]
  },
  agent: {
    tag: "探索方向",
    title: "AI Agent",
    body: [
      "正在了解 AI Agent 的基本构成：模型、提示词、工具调用与工作流。",
      "相比只会聊天，我更想弄明白智能体如何拆解任务、使用工具，并把一件事真正做完。",
      "希望有一天，能把它用到真正有用的场景里。"
    ]
  },
  letter: {
    tag: "写给自己",
    title: "致未来的尘白",
    body: [
      "如果你读到这里，说明这段话已经陪了你一段时间。",
      "我希望那时的你，已经不再为虚度而懊恼，而是能平静地说一句：我没有辜负后来的日子。",
      "自认天命不凡，资质尚可。剩下的，交给行动。"
    ]
  }
};

const modal = document.getElementById("modal");
const modalTag = document.getElementById("modalTag");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalClose = modal.querySelector(".modal-close");
let lastFocused = null;

function openModal(key) {
  const data = modalData[key];
  if (!data) return;

  lastFocused = document.activeElement;
  modalTag.textContent = data.tag;
  modalTitle.textContent = data.title;
  modalBody.replaceChildren(
    ...data.body.map((paragraph) => {
      const p = document.createElement("p");
      p.textContent = paragraph;
      return p;
    })
  );

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modalClose.focus();
}

function closeModal() {
  if (!modal.classList.contains("open")) return;

  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";

  if (lastFocused && typeof lastFocused.focus === "function") {
    lastFocused.focus();
  }
}

document.querySelectorAll("[data-modal]").forEach((trigger) => {
  trigger.addEventListener("click", () => openModal(trigger.dataset.modal));
});

modal.querySelectorAll("[data-close]").forEach((element) => {
  element.addEventListener("click", closeModal);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModal();
    closeNav();
  }
});

document.getElementById("year").textContent = new Date().getFullYear();
