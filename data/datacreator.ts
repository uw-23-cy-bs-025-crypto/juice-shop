/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

/* jslint node: true */
import { AddressModel } from '../models/address'
import { BasketModel } from '../models/basket'
import { BasketItemModel } from '../models/basketitem'
import { CardModel } from '../models/card'
import { ChallengeModel } from '../models/challenge'
import { ComplaintModel } from '../models/complaint'
import { DeliveryModel } from '../models/delivery'
import { FeedbackModel } from '../models/feedback'
import { HintModel } from '../models/hint'
import { MemoryModel } from '../models/memory'
import { ProductModel } from '../models/product'
import { QuantityModel } from '../models/quantity'
import { RecycleModel } from '../models/recycle'
import { SecurityAnswerModel } from '../models/securityAnswer'
import { SecurityQuestionModel } from '../models/securityQuestion'
import { UserModel } from '../models/user'
import { WalletModel } from '../models/wallet'
import { type Product } from './types'
import logger from '../lib/logger'
import { getCodeChallenges } from '../lib/codingChallenges'
import type { Memory as MemoryConfig, Product as ProductConfig } from '../lib/config.types'
import config from 'config'
import * as utils from '../lib/utils'
import type { StaticUser, StaticUserAddress, StaticUserCard } from './staticData'
import { loadStaticChallengeData, loadStaticDeliveryData, loadStaticUserData, loadStaticSecurityQuestionsData } from './staticData'
import { ordersCollection, reviewsCollection } from './mongodb'
import { AllHtmlEntities as Entities } from 'html-entities'
import * as datacache from './datacache'
import * as security from '../lib/insecurity'
import replace from 'replace'

const entities = new Entities()

export default async () => {
  const creators = [
    createSecurityQuestions,
    createUsers,
    createChallenges,
    createRandomFakeUsers,
    createProducts,
    createBaskets,
    createBasketItems,
    createAnonymousFeedback,
    createComplaints,
    createRecycleItem,
    createOrders,
    createQuantity,
    createWallet,
    createDeliveryMethods,
    createMemories,
    prepareFilesystem
  ]

  for (const creator of creators) {
    await creator()
  }
}

async function createChallenges () {
  const showHints = config.get<boolean>('challenges.showHints')
  const showMitigations = config.get<boolean>('challenges.showMitigations')

  const challenges = await loadStaticChallengeData()
  const codeChallenges = await getCodeChallenges()
  const challengeKeysWithCodeChallenges = [...codeChallenges.keys()]

  await Promise.all(
    challenges.map(async ({ name, category, description, difficulty, hints, mitigationUrl, key, disabledEnv, tutorial, tags }) => {
      const { enabled: isChallengeEnabled, disabledBecause } = utils.getChallengeEnablementStatus({ disabledEnv: disabledEnv?.join(';') ?? '' } as ChallengeModel)
      description = description.replace('juice-sh.op', config.get<string>('application.domain'))
      description = description.replace('&lt;iframe width=&quot;100%&quot; height=&quot;166&quot; scrolling=&quot;no&quot; frameborder=&quot;no&quot; allow=&quot;autoplay&quot; src=&quot;https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/771984076&amp;color=%23ff5500&amp;auto_play=true&amp;hide_related=false&amp;show_comments=true&amp;show_user=true&amp;show_reposts=false&amp;show_teaser=true&quot;&gt;&lt;/iframe&gt;', entities.encode(config.get('challenges.xssBonusPayload')))
      const hasCodingChallenge = challengeKeysWithCodeChallenges.includes(key)

      if (hasCodingChallenge) {
        tags = tags ? [...tags, 'With Coding Challenge'] : ['With Coding Challenge']
      }

      try {
        datacache.challenges[key] = await ChallengeModel.create({
          key,
          name,
          category,
          tags: tags ? tags.join(',') : undefined,
          description: isChallengeEnabled ? description : (description + ` <em>(This challenge is <strong>potentially harmful</strong> on ${disabledBecause}!)</em>`),
          difficulty,
          solved: false,
          mitigationUrl: showMitigations ? mitigationUrl : null,
          disabledEnv: disabledBecause,
          tutorialOrder: tutorial?.order ?? null,
          codingChallengeStatus: 0,
          hasCodingChallenge
        })

        if (showHints && hints?.length > 0) await createHints(datacache.challenges[key].id, hints)
      } catch (err) {
        logger.error(`Could not insert Challenge ${name}: ${utils.getErrorMessage(err)}`)
      }
    })
  )
}

async function createHints (ChallengeId: number, hints: string[]) {
  let i = 0
  return await Promise.all(
    hints.map(async (hint) => {
      hint = hint.replace(/OWASP Juice Shop/, config.get<string>('application.name'))
      return await HintModel.create({
        ChallengeId,
        text: hint,
        order: ++i,
        unlocked: false
      }).catch(err => logger.error(`Could not create hint: ${utils.getErrorMessage(err)}`))
    })
  )
}

async function createUsers () {
  const users = await loadStaticUserData()

  await Promise.all(
    users.map(async ({
      username, email, password, customDomain, key, role, deletedFlag,
      profileImage, securityQuestion, feedback, address, card, totpSecret, lastLoginIp = ''
    }) => {
      try {
        const completeEmail = customDomain ? email : `${email}@${config.get<string>('application.domain')}`
        const user = await UserModel.create({
          username,
          email: completeEmail,
          password,
          role,
          deluxeToken: role === security.roles.deluxe ? security.deluxeToken(completeEmail) : '',
          profileImage: `assets/public/images/uploads/${profileImage ?? (role === security.roles.admin ? 'defaultAdmin.png' : 'default.svg')}`,
          totpSecret,
          lastLoginIp
        })

        datacache.users[key] = user

        if (securityQuestion) await createSecurityAnswer(user.id, securityQuestion.id, securityQuestion.answer)
        if (feedback) await createFeedback(user.id, feedback.comment, feedback.rating, user.email)
        if (deletedFlag) await deleteUser(user.id)
        if (address) await createAddresses(user.id, address)
        if (card) await createCards(user.id, card)

      } catch (err) {
        logger.error(`Could not insert User ${key}: ${utils.getErrorMessage(err)}`)
      }
    })
  )
}

async function createWallet () {
  const users = await loadStaticUserData()
  return await Promise.all(
    users.map(async (user: StaticUser, index: number) => {
      return await WalletModel.create({
        UserId: index + 1,
        balance: user.walletBalance ?? 0
      }).catch(err => logger.error(`Could not create wallet: ${utils.getErrorMessage(err)}`))
    })
  )
}

async function createDeliveryMethods () {
  const deliveries = await loadStaticDeliveryData()

  await Promise.all(
    deliveries.map(async ({ name, price, deluxePrice, eta, icon }) => {
      try {
        await DeliveryModel.create({ name, price, deluxePrice, eta, icon })
      } catch (err) {
        logger.error(`Could not insert Delivery Method: ${utils.getErrorMessage(err)}`)
      }
    })
  )
}

async function createAddresses (UserId: number, addresses: StaticUserAddress[]) {
  return await Promise.all(
    addresses.map(addr =>
      AddressModel.create({
        UserId,
        country: addr.country,
        fullName: addr.fullName,
        mobileNum: addr.mobileNum,
        zipCode: addr.zipCode,
        streetAddress: addr.streetAddress,
        city: addr.city,
        state: addr.state ?? null
      }).catch(err => logger.error(`Could not create address: ${utils.getErrorMessage(err)}`))
    )
  )
}

async function createCards (UserId: number, cards: StaticUserCard[]) {
  return await Promise.all(
    cards.map(card =>
      CardModel.create({
        UserId,
        fullName: card.fullName,
        cardNum: Number(card.cardNum),
        expMonth: card.expMonth,
        expYear: card.expYear
      }).catch(err => logger.error(`Could not create card: ${utils.getErrorMessage(err)}`))
    )
  )
}

async function deleteUser (userId: number) {
  return await UserModel.destroy({ where: { id: userId } })
    .catch(err => logger.error(`Could not perform soft delete for the user ${userId}: ${utils.getErrorMessage(err)}`))
}

async function deleteProduct (productId: number) {
  return await ProductModel.destroy({ where: { id: productId } })
    .catch(err => logger.error(`Could not perform soft delete for the product ${productId}: ${utils.getErrorMessage(err)}`))
}

async function createRandomFakeUsers () {
  function makeRandomString (len: number) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    return Array(len).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('')
  }

  function randomEmail () {
    return `${makeRandomString(5).toLowerCase()}@${makeRandomString(4).toLowerCase()}.${makeRandomString(2).toLowerCase()}`
  }

  const count = config.get<number>('application.numberOfRandomFakeUsers')

  return await Promise.all(
    Array(count).fill(0).map(() =>
      UserModel.create({
        email: randomEmail(),
        password: makeRandomString(5)
      })
    )
  )
}

async function createQuantity () {
  return await Promise.all(
    config.get<ProductConfig[]>('products').map(async (product, index) => {
      return await QuantityModel.create({
        ProductId: index + 1,
        quantity: product.quantity ?? Math.floor(Math.random() * 70 + 30),
        limitPerUser: product.limitPerUser ?? null
      }).catch(err => logger.error(`Could not create quantity: ${utils.getErrorMessage(err)}`))
    })
  )
}

async function createMemories () {
  const memories = [
    MemoryModel.create({
      imagePath: 'assets/public/images/uploads/ᓚᘏᗢ-#zatschi-#whoneedsfourlegs-1572600969477.jpg',
      caption: '😼 #zatschi #whoneedsfourlegs',
      UserId: datacache.users.bjoernOwasp.id
    }).catch(err => logger.error(`Could not create memory: ${utils.getErrorMessage(err)}`)),

    ...structuredClone(config.get<MemoryConfig[]>('memories')).map(async (memory) => {
      let img = memory.image

      if (utils.isUrl(img)) {
        const file = utils.extractFilename(img)
        await utils.downloadToFile(img, `frontend/dist/frontend/assets/public/images/uploads/${file}`)
        img = file
      }

      if (memory.geoStalkingMetaSecurityQuestion && memory.geoStalkingMetaSecurityAnswer) {
        await createSecurityAnswer(datacache.users.john.id, memory.geoStalkingMetaSecurityQuestion, memory.geoStalkingMetaSecurityAnswer)
        memory.user = 'john'
      }

      if (memory.geoStalkingVisualSecurityQuestion && memory.geoStalkingVisualSecurityAnswer) {
        await createSecurityAnswer(datacache.users.emma.id, memory.geoStalkingVisualSecurityQuestion, memory.geoStalkingVisualSecurityAnswer)
        memory.user = 'emma'
      }

      if (!memory.user || !datacache.users[memory.user]) {
        logger.warn(`Could not find user for memory ${memory.caption}!`)
        return
      }

      const userId = datacache.users[memory.user].id
      return await MemoryModel.create({
        imagePath: 'assets/public/images/uploads/' + img,
        caption: memory.caption,
        UserId: userId
      }).catch(err => logger.error(`Could not create memory: ${utils.getErrorMessage(err)}`))
    })
  ]

  return await Promise.all(memories)
}

async function createProducts () {
  const products = structuredClone(config.get<ProductConfig[]>('products')).map(prod => {
    prod.price = prod.price ?? Math.floor(Math.random() * 9 + 1)
    prod.deluxePrice = prod.deluxePrice ?? prod.price
    prod.description = prod.description || 'Lorem ipsum dolor sit amet, consectetuer adipiscing elit.'
    prod.image = prod.image ?? 'undefined.png'

    if (utils.isUrl(prod.image)) {
      const img = utils.extractFilename(prod.image)
      void utils.downloadToFile(prod.image, `frontend/dist/frontend/assets/public/images/products/${img}`)
      prod.image = img
    }

    return prod
  })

  const christmasProduct = products.find(p => p.useForChristmasSpecialChallenge)
  const leakProduct = products.find(p => p.keywordsForPastebinDataLeakChallenge)
  const tamperProduct = products.find(p => p.urlForProductTamperingChallenge)
  const blueprintProduct = products.find(p => p.fileForRetrieveBlueprintChallenge)

  if (christmasProduct) {
    christmasProduct.description += ' (Seasonal special offer! Limited availability!)'
    christmasProduct.deletedDate = '2014-12-27 00:00:00+00:00'
  }

  if (tamperProduct) {
    tamperProduct.description += ` <a href="${tamperProduct.urlForProductTamperingChallenge}" target="_blank">More...</a>`
    delete tamperProduct.deletedDate
  }

  if (leakProduct) {
    leakProduct.description += ' (This product is unsafe! We plan to remove it from the stock!)'
    leakProduct.deletedDate = '2019-02-1 00:00:00+00:00'
  }

  if (blueprintProduct) {
    let file = blueprintProduct.fileForRetrieveBlueprintChallenge
    if (utils.isUrl(file)) {
      const name = utils.extractFilename(file)
      await utils.downloadToFile(file, `frontend/dist/frontend/assets/public/images/products/${name}`)
      file = name
    }
    datacache.setRetrieveBlueprintChallengeFile(file!)
  }

  return await Promise.all(
    products.map(async ({ reviews = [], useForChristmasSpecialChallenge, urlForProductTamperingChallenge, deletedDate, ...prod }) => {
      const created = await ProductModel.create({
        name: prod.name,
        description: prod.description,
        price: prod.price,
        deluxePrice: prod.deluxePrice ?? prod.price,
        image: prod.image
      }).catch(err => logger.error(`Could not insert Product ${prod.name}: ${utils.getErrorMessage(err)}`))

      if (!created) throw new Error('Failed to persist product!')

      if (useForChristmasSpecialChallenge) datacache.products.christmasSpecial = created
      if (urlForProductTamperingChallenge) {
        datacache.products.osaft = created
        await datacache.challenges.changeProductChallenge.update({
          description: customizeChangeProductChallenge(
            datacache.challenges.changeProductChallenge.description,
            config.get('challenges.overwriteUrlForProductTamperingChallenge'),
            created
          )
        })
      }
      if (deletedDate) void deleteProduct(created.id)

      await Promise.all(
        reviews.map(rv =>
          reviewsCollection.insert({
            message: rv.text,
            author: datacache.users[rv.author].email,
            product: created.id,
            likesCount: 0,
            likedBy: []
          })
        )
      )

      return created
    })
  )

  function customizeChangeProductChallenge (desc: string, customUrl: string, product: Product) {
    let d = desc.replace(/OWASP SSL Advanced Forensic Tool \(O-Saft\)/g, product.name)
    d = d.replace('https://owasp.slack.com', customUrl)
    return d
  }
}

async function createBaskets () {
  const baskets = [
    { UserId: 1 },
    { UserId: 2 },
    { UserId: 3 },
    { UserId: 11 },
    { UserId: 16 }
  ]

  return await Promise.all(
    baskets.map(data =>
      BasketModel.create({ UserId: data.UserId })
        .catch(err => logger.error(`Could not insert Basket for UserId ${data.UserId}: ${utils.getErrorMessage(err)}`))
    )
  )
}

async function createBasketItems () {
  const items = [
    { BasketId: 1, ProductId: 1, quantity: 2 },
    { BasketId: 1, ProductId: 2, quantity: 3 },
    { BasketId: 1, ProductId: 3, quantity: 1 },
    { BasketId: 2, ProductId: 4, quantity: 2 },
    { BasketId: 3, ProductId: 4, quantity: 1 },
    { BasketId: 4, ProductId: 4, quantity: 2 },
    { BasketId: 5, ProductId: 3, quantity: 5 },
    { BasketId: 5, ProductId: 4, quantity: 2 },
  ]

  return await Promise.all(
    items.map(item =>
      BasketItemModel.create(item)
        .catch(err => logger.error(`Could not insert BasketItem for BasketId ${item.BasketId}: ${utils.getErrorMessage(err)}`))
    )
  )
}

async function createAnonymousFeedback () {
  const feedbacks = [
    {
      comment: 'Incompetent customer support! Can\'t even upload photo of broken purchase!<br><em>Support Team: Sorry, only order confirmation PDFs can be attached to complaints!</em>',
      rating: 2
    },
    {
      comment: 'This is <b>the</b> store for awesome stuff of all kinds!',
      rating: 4
    },
    {
      comment: 'Never gonna buy anywhere else from now on! Thanks for the great service!',
      rating: 4
    },
    {
      comment: 'Keep up the good work!',
      rating: 3
    }
  ]

  return await Promise.all(
    feedbacks.map(fb => createFeedback(null, fb.comment, fb.rating))
  )
}

async function createFeedback (UserId: number | null, comment: string, rating: number, author?: string) {
  const authored = author ? `${comment} (***${author.slice(3)})` : `${comment} (anonymous)`
  return await FeedbackModel.create({ UserId, comment: authored, rating })
    .catch(err => logger.error(`Could not insert Feedback ${authored} mapped to UserId ${UserId}: ${utils.getErrorMessage(err)}`))
}

async function createComplaints () {
  return await ComplaintModel.create({
    UserId: 3,
    message: "I'll build my own eCommerce business! With Black Jack! And Hookers!"
  }).catch(err =>
    logger.error(`Could not insert Complaint: ${utils.getErrorMessage(err)}`)
  )
}

async function createRecycleItem () {
  const recycles = [
    { UserId: 2, quantity: 800, AddressId: 4, date: '2270-01-17', isPickup: true },
    { UserId: 3, quantity: 1320, AddressId: 6, date: '2006-01-14', isPickup: true },
    { UserId: 4, quantity: 120, AddressId: 1, date: '2018-04-16', isPickup: true },
    { UserId: 1, quantity: 300, AddressId: 3, date: '2018-01-17', isPickup: true },
    { UserId: 4, quantity: 350, AddressId: 1, date: '2018-03-17', isPickup: true },
    { UserId: 3, quantity: 200, AddressId: 6, date: '2018-07-17', isPickup: true },
    { UserId: 4, quantity: 140, AddressId: 1, date: '2018-03-19', isPickup: true },
    { UserId: 1, quantity: 150, AddressId: 3, date: '2018-05-12', isPickup: true },
    { UserId: 16, quantity: 500, AddressId: 2, date: '2019-02-18', isPickup: true }
  ]

  return await Promise.all(
    recycles.map(data => createRecycle(data))
  )
}

async function createRecycle (data: { UserId: number, quantity: number, AddressId: number, date: string, isPickup: boolean }) {
  return await RecycleModel.create({
    UserId: data.UserId,
    AddressId: data.AddressId,
    quantity: data.quantity,
    isPickup: data.isPickup,
    date: data.date
  }).catch(err => logger.error(`Could not insert Recycling Model: ${utils.getErrorMessage(err)}`))
}

async function createSecurityQuestions () {
  const questions = await loadStaticSecurityQuestionsData()

  await Promise.all(
    questions.map(async ({ question }) => {
      try {
        await SecurityQuestionModel.create({ question })
      } catch (err) {
        logger.error(`Could not insert SecurityQuestion ${question}: ${utils.getErrorMessage(err)}`)
      }
    })
  )
}

async function createSecurityAnswer (UserId: number, SecurityQuestionId: number, answer: string) {
  return await SecurityAnswerModel.create({
    SecurityQuestionId,
    UserId,
    answer
  }).catch(err => logger.error(`Could not insert SecurityAnswer ${answer}: ${utils.getErrorMessage(err)}`))
}

/* ---------------------------------------------------------
   COMPLETED createOrders()  (MISSING PART ADDED)
----------------------------------------------------------- */
async function createOrders () {
  const products = config.get<Product[]>('products')

  const basket1Products = [
    {
      quantity: 3,
      id: products[0].id,
      name: products[0].name,
      price: products[0].price,
      total: products[0].price * 3,
      bonus: Math.round(products[0].price / 10) * 3
    },
    {
      quantity: 1,
      id: products[1].id,
      name: products[1].name,
      price: products[1].price,
      total: products[1].price * 1,
      bonus: Math.round(products[1].price / 10) * 1
    }
  ]

  const basket2Products = [
    {
      quantity: 3,
      id: products[2].id,
      name: products[2].name,
      price: products[2].price,
      total: products[2].price * 3,
      bonus: Math.round(products[2].price / 10) * 3
    }
  ]

  try {
    await ordersCollection.insert({
      UserId: 1,
      orderLines: basket1Products,
      totalPrice: basket1Products.reduce((a, b) => a + b.total, 0),
      bonus: basket1Products.reduce((a, b) => a + b.bonus, 0),
      paymentId: Math.random().toString(36).substring(2),
      state: 'delivered'
    })

    await ordersCollection.insert({
      UserId: 2,
      orderLines: basket2Products,
      totalPrice: basket2Products.reduce((a, b) => a + b.total, 0),
      bonus: basket2Products.reduce((a, b) => a + b.bonus, 0),
      paymentId: Math.random().toString(36).substring(2),
      state: 'processing'
    })

  } catch (err) {
    logger.error(`Could not create Orders: ${utils.getErrorMessage(err)}`)
  }
}

/* ---------------------------------------------------------
   COMPLETED prepareFilesystem() (FULL WORKING VERSION)
----------------------------------------------------------- */
async function prepareFilesystem () {
  try {
    replace({
      regex: 'OWASP Juice Shop',
      replacement: config.get('application.name'),
      paths: ['frontend/dist'],
      recursive: true,
      silent: true
    })

    replace({
      regex: 'OWASP_JUICE_SHOP',
      replacement: config.get('application.name').replace(/ /g, '_').toUpperCase(),
      paths: ['frontend/dist'],
      recursive: true,
      silent: true
    })

  } catch (err) {
    logger.error(`Could not prepare file system: ${utils.getErrorMessage(err)}`)
  }
}
