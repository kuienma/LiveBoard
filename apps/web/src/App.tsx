import type { Drill } from '@drill/schema'
import { createDrill } from './library/api.js'
import { EditorPage } from './editor/EditorPage.js'
import { LibraryPage } from './library/LibraryPage.js'
import { renderThumbnail } from './library/thumbnail.js'
import { PlayerPage } from './player/PlayerPage.js'
import { UploadPage } from './upload/UploadPage.js'
import { useRoute } from './useRoute.js'

export default function App() {
  const [route, navigate] = useRoute()

  /**
   * 识别确认后直接存进训练库，而不是让用户再点一次「保存」——
   * 用户看过理解说明并点了确认，意图已经明确；顺带让刷新页面数据仍在。
   */
  const saveRecognized = async (drill: Drill) => {
    const thumbnail = renderThumbnail(drill)
    const created = await createDrill({
      drill,
      origin: 'recognition',
      ...(thumbnail === undefined ? {} : { thumbnail }),
    })
    navigate({ name: 'drill', id: created.id })
  }

  switch (route.name) {
    case 'upload':
      return (
        <UploadPage
          onCancel={() => navigate({ name: 'library' })}
          onConfirm={saveRecognized}
        />
      )
    case 'drill':
      return (
        <PlayerPage
          id={route.id}
          onBack={() => navigate({ name: 'library' })}
          onEdit={() => navigate({ name: 'edit', id: route.id })}
        />
      )
    case 'edit':
      return (
        <EditorPage id={route.id} onDone={(id) => navigate({ name: 'drill', id })} />
      )
    case 'library':
      return (
        <LibraryPage
          onOpen={(id) => navigate({ name: 'drill', id })}
          onUpload={() => navigate({ name: 'upload' })}
        />
      )
  }
}
