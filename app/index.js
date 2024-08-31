const { chromium } = require('playwright')
const fs = require('fs')
const { Client } = require('pg')
const cuid = require('cuid')
require('dotenv').config()

const processBody = (body, link, resource = 'Al Jazeera') => {
  let formattedBody = ''

  if (body !== null) {
    formattedBody += `<p>${body}</p><br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`
  }

  if (link && !body) {
    formattedBody += `<br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`
  } else if (!link && !body) {
    formattedBody = ''
  }

  return formattedBody
}

;(async () => {
  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING
  })

  console.log('Connecting to the database...')
  try {
    await client.connect()
    console.log('Connected to the database successfully.')

    await client.query('DELETE FROM "Article" WHERE resource = $1', [
      'Al Jazeera'
    ])
    console.log('Truncated existing articles with resource "Al Jazeera".')

    const browser = await chromium.launch({ headless: false })
    const page = await browser.newPage()

    console.log('Navigating to Al Jazeera website...')
    try {
      await page.goto('https://www.aljazeera.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      })
      console.log('Page loaded successfully')

      const cookieButtonSelector = '#onetrust-accept-btn-handler'
      const cookieButtonVisible = await page.isVisible(cookieButtonSelector)

      if (cookieButtonVisible) {
        console.log('Cookie consent banner found, clicking "Allow all"...')
        await page.click(cookieButtonSelector)
        console.log('"Allow all" button clicked.')
      } else {
        console.log('Cookie consent banner not found.')
      }
    } catch (error) {
      console.error('Failed to load Al Jazeera homepage:', error)
      await browser.close()
      await client.end()
      return
    }

    console.log('Scrolling down to find the trending articles section...')
    let trendingArticlesFound = false

    while (!trendingArticlesFound) {
      try {
        trendingArticlesFound = (await page.$('.trending-articles')) !== null
        if (!trendingArticlesFound) {
          console.log('Scrolling down...')
          await page.evaluate(() => window.scrollBy(0, window.innerHeight))
          await page.waitForTimeout(1000)
        }
      } catch (error) {
        console.error('Error while searching for trending articles:', error)
        await browser.close()
        await client.end()
        return
      }
    }

    console.log('Trending articles section found.')

    const articles = await page.$$eval('.trending-articles__list li', items =>
      items.map(item => {
        const headline = item
          .querySelector('.article-trending__title span')
          ?.innerText.trim()
        const link =
          'https://www.aljazeera.com' +
          item
            .querySelector('.article-trending__title-link')
            ?.getAttribute('href')
            .trim()
        const slug = headline
          .split(' ')
          .slice(0, 3)
          .join('')
          .toLowerCase()
          .replace(/[^a-z]/g, '')
        return { headline, link, slug }
      })
    )

    console.log('Collected headlines and links:', articles)

    for (const article of articles) {
      console.log(`Visiting article: ${article.headline}`)

      let success = false
      let attempts = 0
      const maxAttempts = 3

      while (!success && attempts < maxAttempts) {
        attempts++
        try {
          await page.goto(article.link, {
            waitUntil: 'domcontentloaded',
            timeout: 10000
          })

          try {
            article.summary = await page.$eval('#wysiwyg li', el =>
              el.innerText.split(' ').slice(0, 40).join(' ')
            )
          } catch (err) {
            console.error(`Error finding summary with first selector: `, err)
            try {
              article.summary = await page.$eval('.article__subhead em', el =>
                el.innerText.trim()
              )
            } catch (err) {
              console.error(`Error finding summary with second selector: `, err)
              try {
                article.summary = await page.$eval('#wysiwyg p', el =>
                  el.innerText.split(' ').slice(0, 40).join(' ').trim()
                )
              } catch (err) {
                console.error(
                  `Error finding summary with third selector: `,
                  err
                )
                article.summary = ''
              }
            }
          }

          // Extract body and remove unnecessary sections
          try {
            article.body = await page.$eval('#wysiwyg', el => {
              // Remove the "More On" section, newsletter widgets, ads, and other unnecessary elements
              const elementsToRemove = ['.more-on', '.sib-newsletter-form', '.advertisement', '.ad-container', '.widget'];
              elementsToRemove.forEach(selector => {
                const elements = el.querySelectorAll(selector);
                elements.forEach(element => element.remove());
              });

              // Additionally remove ads using your specific selectors
              const ads = el.querySelectorAll('.advertisement, .ad, .ads');
              ads.forEach(ad => ad.remove());

              return el.innerText.trim();
            });
          } catch (err) {
            console.error(`Error finding body with first selector: `, err);
            try {
              article.body = await page.$eval('.wysiwyg--all-content', el => {
                const elementsToRemove = ['.more-on', '.sib-newsletter-form', '.advertisement', '.ad-container', '.widget'];
                elementsToRemove.forEach(selector => {
                  const elements = el.querySelectorAll(selector);
                  elements.forEach(element => element.remove());
                });

                const ads = el.querySelectorAll('.advertisement, .ad, .ads');
                ads.forEach(ad => ad.remove());

                return el.innerText.trim();
              });
            } catch (err) {
              console.error(`Error finding body with second selector: `, err);
              try {
                article.body = await page.$eval('.wysiwyg ul', el => {
                  const elementsToRemove = ['.more-on', '.sib-newsletter-form', '.advertisement', '.ad-container', '.widget'];
                  elementsToRemove.forEach(selector => {
                    const elements = el.querySelectorAll(selector);
                    elements.forEach(element => element.remove());
                  });

                  const ads = el.querySelectorAll('.advertisement, .ad, .ads');
                  ads.forEach(ad => ad.remove());

                  return el.innerText.trim();
                });
              } catch (err) {
                console.error(`Error finding body with third selector: `, err);
                article.body = '';
              }
            }
          }

          article.body = processBody(article.body, article.link);


          try {
            article.author = await page.$eval(
              '.article-author-name-item a.author-link',
              el => el?.innerText.trim()
            )
          } catch (err) {
            console.error(`Error finding author: `, err)
            article.author = 'See article for details'
          }

          try {
            article.media = await extractMainImage(page)
          } catch (err) {
            console.error(`Error finding media: `, err)
            article.media =
              'https://upload.wikimedia.org/wikipedia/en/thumb/8/8f/Al_Jazeera_Media_Network_Logo.svg/1200px-Al_Jazeera_Media_Network_Logo.svg.png'
          }

          try {
            const rawDate = await page.$eval(
              '.date-simple span[aria-hidden="true"]',
              el => el?.innerText.trim()
            )
            const date = new Date(rawDate)
            article.date = date.toISOString()
          } catch (err) {
            console.error(`Error finding date: `, err)
            article.date = ''
          }

          article.resource = 'Al Jazeera'

          article.id = cuid()

          // Insert article into the database
          await client.query(
            `INSERT INTO "Article" (id, slug, headline, summary, body, author, resource, media, link, date) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              article.id,
              article.slug,
              article.headline,
              article.summary || '',
              article.body || '',
              article.author,
              article.resource,
              article.media,
              article.link,
              article.date
            ]
          )

          success = true
          console.log(
            `Collected and saved data for article: ${article.headline}`
          )
        } catch (error) {
          console.error(
            `Error processing article: ${article.headline}, attempt ${attempts}`,
            error
          )
          if (attempts >= maxAttempts) {
            console.error(
              `Failed to load article after ${maxAttempts} attempts.`
            )
          }
        }
      }
    }

    fs.writeFileSync(
      'enriched-articles.json',
      JSON.stringify(articles, null, 2)
    )
    await browser.close()
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await client.end()
    console.log('Database connection closed.')
  }
})()

async function extractMainImage (page) {
  try {
    const mediaSelector = '.featured-media__image-wrap img'
    return await page.$eval(mediaSelector, img => {
      let src = img.src
      if (!src.startsWith('http')) {
        src = 'https://www.aljazeera.com' + src
      }
      return src
    })
  } catch (error) {
    console.log(
      'Main image not found using the primary selector, trying the first fallback selector.'
    )
    try {
      const fallbackMediaSelector = '.responsive-image img'
      return await page.$eval(fallbackMediaSelector, img => {
        let src = img.src
        if (!src.startsWith('http')) {
          src = 'https://www.aljazeera.com' + src
        }
        return src
      })
    } catch (fallbackError) {
      console.log(
        'Main image not found with the first fallback selector, trying the second fallback.'
      )
      try {
        const content = await page.content()
        const regex =
          /\/wp-content\/uploads\/\d{4}\/\d{2}\/[^\s"]+\.jpg\?resize=\d+%2C\d+&quality=\d+/g
        const match = regex.exec(content)
        if (match) {
          console.log('First image URL found using regex.')
          return 'https://www.aljazeera.com' + match[0]
        } else {
          console.log(
            'No image URL found using regex, returning default image.'
          )
          return 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8f/Al_Jazeera_Media_Network_Logo.svg/1200px-Al_Jazeera_Media_Network_Logo.svg.png'
        }
      } catch (regexError) {
        console.log(
          'Error while searching for image URL using regex.',
          regexError
        )
        return 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8f/Al_Jazeera_Media_Network_Logo.svg/1200px-Al_Jazeera_Media_Network_Logo.svg.png'
      }
    }
  }
}
