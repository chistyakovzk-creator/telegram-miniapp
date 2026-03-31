#!/usr/bin/env python3
"""
Бот «Тапни слона» на aiogram 3: /start → фото (если есть elephant.jpg) + текст + кнопка Web App.

Запуск:
  export BOT_TOKEN="токен_от_BotFather"
  pip install -r requirements.txt
  python bot.py

Положи рядом с bot.py файл elephant.jpg — тогда уйдёт картинка; иначе бот отправит только текст с кнопкой.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from aiogram import Bot, Dispatcher, Router
from aiogram.filters import CommandStart
from aiogram.types import (
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

MINI_APP_URL = os.environ.get(
    "MINI_APP_URL",
    "https://chistyakovzk-creator.github.io/telegram-miniapp/",
)

CAPTION = (
    "🐘 Добро пожаловать в «Тапни слона»\n\n"
    "Тапай слона, усиливай влияние и веди «Новые люди» к победе.\n\n"
    "👇 Начни прямо сейчас"
)

router = Router()


def build_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Тапать 🐘",
                    web_app=WebAppInfo(url=MINI_APP_URL),
                )
            ]
        ]
    )


@router.message(CommandStart())
async def cmd_start(message: Message, bot: Bot) -> None:
    kb = build_keyboard()
    photo_path = Path(__file__).resolve().parent / "elephant.jpg"

    if photo_path.is_file():
        await bot.send_photo(
            chat_id=message.chat.id,
            photo=FSInputFile(photo_path),
            caption=CAPTION,
            reply_markup=kb,
        )
    else:
        logger.warning("Файл elephant.jpg не найден рядом с bot.py — отправляю текст")
        await message.answer(CAPTION, reply_markup=kb)


async def main() -> None:
    token = os.environ.get("BOT_TOKEN")
    if not token:
        raise SystemExit(
            "Укажи переменную окружения BOT_TOKEN (токен от @BotFather). "
            "Не вставляй токен в код и не публикуй его."
        )

    bot = Bot(token=token)
    dp = Dispatcher()
    dp.include_router(router)
    logger.info("Бот запущен (polling). Ctrl+C — остановка.")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
